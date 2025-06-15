/******************************************************************
 *  Shopify Points + Referral Webhooks – FINAL PATCHED VERSION
 ******************************************************************/

const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const app = express();

const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN || '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';
const SHOPIFY_STORE        = 'j0f9pj-rd.myshopify.com';
const API_VERSION          = '2024-04';

app.use(bodyParser.json());

/* --------------------  Helper : Fetch referrer by metafield -------------------- */
async function getReferrerByCode(refCode, excludeId = null) {
  let url = `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/customers.json?limit=100`;

  while (url) {
    const res = await axios.get(url, {
      headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN }
    });

    for (const customer of res.data.customers) {
      if (excludeId && customer.id === excludeId) continue;

      const metas = await axios.get(
        `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/customers/${customer.id}/metafields.json`,
        { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } }
      );

      const match = metas.data.metafields.find(
        mf => mf.namespace === 'referral' && mf.key === 'code' && mf.value === refCode
      );
      if (match) return customer;
    }

    const link = res.headers.link;
    const nextLink = link && link.match(/<([^>]+)>;\s*rel="next"/);
    url = nextLink ? nextLink[1] : null;
  }

  return null;
}

/* --------------------  /webhook/orders  -------------------- */
app.post('/webhook/orders', async (req, res) => {
  const order = req.body;
  if (!order?.customer) return res.status(400).send('No customer');

  const customerId  = order.customer.id;
  const orderTotal  = parseFloat(order.total_price);

  /* fetch latest customer */
  let customerData;
  try {
    const cRes = await axios.get(
      `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/customers/${customerId}.json`,
      { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } }
    );
    customerData = cRes.data.customer;
  } catch (err) {
    console.error('❌ fetch customer failed', err.response?.data || err.message);
    return res.status(500).send('fetch error');
  }

  const tags = customerData.tags?.split(',').map(t => t.trim()) || [];
  const note = customerData.note || '';

  if (!tags.includes('age_verified')) return res.status(200).send('Not verified');

  /* ------------ One-time referral reward inside ORDERS route ------------ */
  if (!tags.includes('referral_rewarded')) {
    const refMatch = note.match(/ref:(\d+)/);
    if (refMatch) {
      const refCode = refMatch[1];
      try {
        const referrer = await getReferrerByCode(refCode);
        if (referrer) {
          /* read referrer points */
          const mRes = await axios.get(
            `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/customers/${referrer.id}/metafields.json`,
            { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } }
          );
          let current = 0, mId = null;
          mRes.data.metafields.forEach(mf => {
            if (mf.namespace === 'loyalty' && mf.key === 'points') {
              current = parseInt(mf.value) || 0;
              mId = mf.id;
            }
          });
          const newPts = current + 10;
          if (mId) {
            await axios.put(
              `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/metafields/${mId}.json`,
              { metafield: { value: newPts, type: 'number_integer' } },
              { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } }
            );
          } else {
            await axios.post(
              `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/customers/${referrer.id}/metafields.json`,
              {
                metafield: {
                  namespace: 'loyalty',
                  key: 'points',
                  value: newPts,
                  type: 'number_integer'
                }
              },
              { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } }
            );
          }
          /* tag customer to avoid double rewards */
          await axios.put(
            `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/customers/${customerId}.json`,
            { customer: { id: customerId, tags: [...tags, 'referral_rewarded'].join(', ') } },
            { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } }
          );
          console.log('🎉 Referrer rewarded via orders webhook');
        }
      } catch (e) {
        console.error('Referral reward error (orders)', e.response?.data || e.message);
      }
    }
  }

  /* ------------ Order-amount points ------------ */
  let points = Math.floor(orderTotal / 50);
  if (tags.some(t => t.startsWith('referrer-'))) points += Math.floor(points * 0.05);

  try {
    const mRes = await axios.get(
      `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/customers/${customerId}/metafields.json`,
      { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } }
    );
    let cur = 0, mId = null;
    mRes.data.metafields.forEach(mf => {
      if (mf.namespace === 'loyalty' && mf.key === 'points') {
        cur = parseInt(mf.value) || 0;
        mId = mf.id;
      }
    });
    const newTotal = cur + points;
    if (mId) {
      await axios.put(
        `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/metafields/${mId}.json`,
        { metafield: { value: newTotal, type: 'number_integer' } },
        { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } }
      );
    } else {
      await axios.post(
        `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/customers/${customerId}/metafields.json`,
        {
          metafield: { namespace: 'loyalty', key: 'points', value: newTotal, type: 'number_integer' }
        },
        { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } }
      );
    }
  } catch (e) {
    console.error('❌ point update error:', e.response?.data || e.message);
  }

  return res.status(200).send('Order webhook processed');
});

/* --------------------  /webhook/customers/update  -------------------- */
// ✅ Webhook: customers/update — reward referrer if age_verified
app.post('/webhook/customers/update', async (req, res) => {
  const webhookCustomer = req.body;
  const customerId = webhookCustomer.id;

  console.log("✅ customers/update webhook triggered for ID:", customerId);

  let customerData;
  try {
    const customerRes = await axios.get(
      `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/customers/${customerId}.json`,
      {
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN
        }
      }
    );
    customerData = customerRes.data.customer;
  } catch (err) {
    console.error("❌ Failed to fetch customer data:", err.response?.data || err.message);
    return res.status(500).send("Failed to fetch customer data");
  }

  const tags = customerData.tags?.split(',').map(t => t.trim()) || [];
  const note = customerData.note || '';

  console.log("📌 Latest customer tags:", tags);
  console.log("📌 Customer note:", note);

  if (!tags.includes('age_verified') || tags.includes('referral_rewarded')) {
    return res.status(200).send("No action needed");
  }

  const refMatch = note.match(/ref:(\d+)/);
  if (!refMatch) return res.status(200).send("No referral code found");

  const refCode = refMatch[1];

  try {
    const referrer = await getReferrerByCode(refCode, customerId);
    if (!referrer) return res.status(200).send("Referrer not found");

    const refMetaRes = await axios.get(
      `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/customers/${referrer.id}/metafields.json`,
      {
        headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN }
      }
    );

    let currentPoints = 0;
    let pointsId = null;
    refMetaRes.data.metafields.forEach(mf => {
      if (mf.namespace === 'loyalty' && mf.key === 'points') {
        currentPoints = parseInt(mf.value);
        pointsId = mf.id;
      }
    });

    const newPoints = currentPoints + 10;

    if (pointsId) {
      await axios.put(`https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/metafields/${pointsId}.json`, {
        metafield: { value: newPoints, type: 'number_integer' }
      }, {
        headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN }
      });
    } else {
      await axios.post(`https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/customers/${referrer.id}/metafields.json`, {
        metafield: {
          namespace: 'loyalty',
          key: 'points',
          value: newPoints,
          type: 'number_integer'
        }
      }, {
        headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN }
      });
    }

    const updatedTags = [...tags, 'referral_rewarded'];
    await axios.put(`https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/customers/${customerId}.json`, {
      customer: {
        id: customerId,
        tags: updatedTags.join(', ')
      }
    }, {
      headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN }
    });

    console.log(`🎉 10 points added to referrer ID: ${referrer.id}`);
    return res.status(200).send("Referral reward granted");

  } catch (err) {
    console.error("❌ Error in referral reward process:", err.response?.data || err.message);
    return res.status(500).send("Internal server error");
  }
});

/* --------------------  Start server  -------------------- */
app.listen(3000, () => console.log('🚀 Server listening on 3000'));
