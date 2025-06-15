const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const app = express();

const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN || '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';
const SHOPIFY_STORE        = 'j0f9pj-rd.myshopify.com';
const API_VERSION          = '2024-04';

app.use(bodyParser.json());

/* ------------------ Helper: Find referrer by metafield ------------------ */
async function getReferrerByCode(refCode, excludeId = null) {
  const query = `metafield:referral.code=${refCode}`;
  const url = `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/customers/search.json?query=${encodeURIComponent(query)}`;

  const res = await axios.get(url, {
    headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN }
  });

  const referrer = res.data.customers.find(c => c.id !== excludeId);
  return referrer || null;
}

/* ------------------ Webhook: customers/update ------------------ */
app.post('/webhook/customers/update', async (req, res) => {
  const customerId = req.body.id;
  console.log(`✅ customers/update webhook triggered for ID: ${customerId}`);

  try {
    const { data } = await axios.get(
      `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/customers/${customerId}.json`,
      { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } }
    );
    const customer = data.customer;
    const tags = customer.tags?.split(',').map(t => t.trim()) || [];
    const note = customer.note || '';

    if (!tags.includes('age_verified') || tags.includes('referral_rewarded')) {
      return res.status(200).send('No action needed');
    }

    const refMatch = note.match(/ref:(\d+)/);
    if (!refMatch) return res.status(200).send('No referral code found');
    const refCode = refMatch[1];

    const referrer = await getReferrerByCode(refCode, customerId);
    if (!referrer) return res.status(200).send('Referrer not found');

    const { data: meta } = await axios.get(
      `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/customers/${referrer.id}/metafields.json`,
      { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } }
    );

    let current = 0, mId = null;
    for (const mf of meta.metafields) {
      if (mf.namespace === 'loyalty' && mf.key === 'points') {
        current = parseInt(mf.value) || 0;
        mId = mf.id;
      }
    }

    const newPoints = current + 10;
    const payload = {
      metafield: {
        namespace: 'loyalty',
        key: 'points',
        value: newPoints,
        type: 'number_integer'
      }
    };

    if (mId) {
      await axios.put(
        `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/metafields/${mId}.json`,
        payload,
        { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } }
      );
    } else {
      await axios.post(
        `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/customers/${referrer.id}/metafields.json`,
        payload,
        { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } }
      );
    }

    await axios.put(
      `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/customers/${customerId}.json`,
      {
        customer: {
          id: customerId,
          tags: [...tags, 'referral_rewarded'].join(', ')
        }
      },
      { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } }
    );

    console.log(`🎉 Referral reward: 10 points → Referrer ID: ${referrer.id}`);
    return res.status(200).send('Referral rewarded');
  } catch (err) {
    console.error('❌ customers/update error:', err.response?.data || err.message);
    return res.status(500).send('Internal server error');
  }
});

/* ------------------ Webhook: orders/create ------------------ */
app.post('/webhook/orders', async (req, res) => {
  const order = req.body;
  const customerId = order?.customer?.id;
  const total = parseFloat(order.total_price || 0);

  if (!customerId || isNaN(total)) return res.status(400).send('Invalid order data');

  try {
    const { data } = await axios.get(
      `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/customers/${customerId}.json`,
      { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } }
    );

    const customer = data.customer;
    const tags = customer.tags?.split(',').map(t => t.trim()) || [];
    const note = customer.note || '';

    // 🔁 Referral Reward (only once)
    if (!tags.includes('referral_rewarded')) {
      const refMatch = note.match(/ref:(\d+)/);
      if (refMatch) {
        const refCode = refMatch[1];
        const referrer = await getReferrerByCode(refCode, customerId);
        if (referrer) {
          const { data: meta } = await axios.get(
            `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/customers/${referrer.id}/metafields.json`,
            { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } }
          );

          let current = 0, mId = null;
          for (const mf of meta.metafields) {
            if (mf.namespace === 'loyalty' && mf.key === 'points') {
              current = parseInt(mf.value) || 0;
              mId = mf.id;
            }
          }

          const newPoints = current + 10;
          const payload = {
            metafield: {
              namespace: 'loyalty',
              key: 'points',
              value: newPoints,
              type: 'number_integer'
            }
          };

          if (mId) {
            await axios.put(
              `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/metafields/${mId}.json`,
              payload,
              { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } }
            );
          } else {
            await axios.post(
              `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/customers/${referrer.id}/metafields.json`,
              payload,
              { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } }
            );
          }

          // Tag this customer to avoid duplicate rewards
          await axios.put(
            `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/customers/${customerId}.json`,
            { customer: { id: customerId, tags: [...tags, 'referral_rewarded'].join(', ') } },
            { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } }
          );

          console.log(`🎁 Order Referral: 10 pts → Referrer ID: ${referrer.id}`);
        }
      }
    }

    // 💎 Order Total Points
    let points = Math.floor(total / 50);
    if (tags.some(t => t.startsWith('referrer-'))) points += Math.floor(points * 0.05);

    const { data: metas } = await axios.get(
      `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/customers/${customerId}/metafields.json`,
      { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } }
    );

    let current = 0, mId = null;
    for (const mf of metas.metafields) {
      if (mf.namespace === 'loyalty' && mf.key === 'points') {
        current = parseInt(mf.value) || 0;
        mId = mf.id;
      }
    }

    const newTotal = current + points;
    const payload = {
      metafield: {
        namespace: 'loyalty',
        key: 'points',
        value: newTotal,
        type: 'number_integer'
      }
    };

    if (mId) {
      await axios.put(
        `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/metafields/${mId}.json`,
        payload,
        { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } }
      );
    } else {
      await axios.post(
        `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/customers/${customerId}/metafields.json`,
        payload,
        { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } }
      );
    }

    console.log(`💰 Order Points: +${points} to customer ID ${customerId}`);
    return res.status(200).send('Order webhook processed');
  } catch (err) {
    console.error('❌ order webhook error:', err.response?.data || err.message);
    return res.status(500).send('Internal error');
  }
});

/* ------------------ Start Server ------------------ */
app.listen(3000, () => console.log('🚀 Webhook server running on port 3000'));
