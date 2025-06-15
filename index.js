const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const app = express();

const SHOPIFY_ACCESS_TOKEN = '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';
const SHOPIFY_STORE = 'j0f9pj-rd.myshopify.com';
const API_VERSION = '2024-04';

app.use(bodyParser.json());

// ✅ Orders webhook
app.post('/webhook/orders', async (req, res) => {
  const order = req.body;
  if (!order || !order.customer) return res.status(400).send("No customer");

  const customerId = order.customer.id;
  const orderTotal = parseFloat(order.total_price);

  let customerRes;
  try {
    customerRes = await axios.get(`https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/customers/${customerId}.json`, {
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN
      }
    });
  } catch (err) {
    console.error("Failed to fetch customer data:", err.response?.data);
    return res.status(404).send("Customer not found");
  }

  const customerData = customerRes.data.customer;
  const tags = customerData.tags.split(', ').map(t => t.trim());
  const note = customerData.note || '';

  if (!tags.includes('age_verified')) return res.status(200).send("Not verified");

  // ✅ Handle referral reward if not yet given
  if (!tags.includes('referral_rewarded')) {
    const refMatch = note.match(/ref:(\d+)/);
    if (refMatch) {
      const refCode = refMatch[1];

      try {
        const refSearch = await axios.get(
          `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/customers/search.json?query=metafield:referral.code=${refCode}`,
          { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } }
        );

        const referrer = refSearch.data.customers?.[0];
        if (referrer) {
          const refMetaRes = await axios.get(`https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/customers/${referrer.id}/metafields.json`, {
            headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN }
          });

          let currentRefPoints = 0;
          let refPointsId = null;
          refMetaRes.data.metafields.forEach(mf => {
            if (mf.namespace === 'loyalty' && mf.key === 'points') {
              currentRefPoints = parseInt(mf.value);
              refPointsId = mf.id;
            }
          });

          const updatedRefPoints = currentRefPoints + 10;

          if (refPointsId) {
            await axios.put(`https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/metafields/${refPointsId}.json`, {
              metafield: { value: updatedRefPoints, type: 'number_integer' }
            }, {
              headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN }
            });
          } else {
            await axios.post(`https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/customers/${referrer.id}/metafields.json`, {
              metafield: {
                namespace: 'loyalty',
                key: 'points',
                value: updatedRefPoints,
                type: 'number_integer'
              }
            }, {
              headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN }
            });
          }

          const newTags = [...tags, 'referral_rewarded'];
          await axios.put(`https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/customers/${customerId}.json`, {
            customer: { id: customerId, tags: newTags.join(', ') }
          }, {
            headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN }
          });
        }
      } catch (err) {
        console.error("Referral processing error:", err.response?.data || err.message);
      }
    }
  }

  // ✅ Points from orders
  let points = Math.floor(orderTotal / 50);
  if (tags.find(tag => tag.startsWith('referrer-'))) {
    points += Math.floor(points * 0.05);
  }

  const metafieldsRes = await axios.get(`https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/customers/${customerId}/metafields.json`, {
    headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN }
  });

  let currentPoints = 0;
  let pointsMetafieldId = null;
  metafieldsRes.data.metafields.forEach(mf => {
    if (mf.namespace === 'loyalty' && mf.key === 'points') {
      currentPoints = parseInt(mf.value);
      pointsMetafieldId = mf.id;
    }
  });

  const newTotal = currentPoints + points;

  if (pointsMetafieldId) {
    await axios.put(`https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/metafields/${pointsMetafieldId}.json`, {
      metafield: { value: newTotal, type: 'number_integer' }
    }, {
      headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN }
    });
  } else {
    await axios.post(`https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/customers/${customerId}/metafields.json`, {
      metafield: {
        namespace: 'loyalty',
        key: 'points',
        value: newTotal,
        type: 'number_integer'
      }
    }, {
      headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN }
    });
  }

  return res.status(200).send("Points added and referral checked");
});

// ✅ New webhook for customer update (age_verified check)
app.post('/webhook/customers/update', async (req, res) => {
  const customer = req.body;

  const customerId = customer.id;
  const rawTags = customer.tags || ''; // ✅ fallback to empty string
  const tags = rawTags.split(',').map(t => t.trim()).filter(Boolean); // ✅ safe split
  const note = customer.note || '';

  console.log("✅ customers/update webhook triggered");

  if (!tags.includes('age_verified') || tags.includes('referral_rewarded')) {
    return res.status(200).send("No action");
    console.log("Customer tags:", tags);
  }

  const refMatch = note.match(/ref:(\d+)/);
  if (!refMatch) return res.status(200).send("No referral code");

  const refCode = refMatch[1];

  try {
    const refSearch = await axios.get(
      `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/customers/search.json?query=metafield:referral.code=${refCode}`,
      { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } }
    );

    const referrer = refSearch.data.customers?.[0];
    if (!referrer) return res.status(200).send("Referrer not found");

    const refMetaRes = await axios.get(`https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/customers/${referrer.id}/metafields.json`, {
      headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN }
    });

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

    const newTags = [...tags, 'referral_rewarded'];
    await axios.put(`https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/customers/${customerId}.json`, {
      customer: {
        id: customerId,
        tags: newTags.join(', ')
      }
    }, {
      headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN }
    });

    return res.status(200).send("Referral reward granted");

  } catch (err) {
    console.error("Error in customer update webhook:", err.response?.data || err.message);
    return res.status(500).send("Internal server error");
  }
});



app.listen(3000, () => {
  console.log("Listening on port 3000");
});
