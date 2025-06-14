const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const app = express();

const SHOPIFY_ACCESS_TOKEN = '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';
const SHOPIFY_STORE = 'j0f9pj-rd.myshopify.com';

app.use(bodyParser.json());

app.post('/webhook/orders', async (req, res) => {
  const order = req.body;
  if (!order || !order.customer) return res.status(400).send("No customer");

  const customerId = order.customer.id;
  const orderTotal = parseFloat(order.total_price);

  // Fetch customer data
  const customerRes = await axios.get(`https://${SHOPIFY_STORE}/admin/api/2024-04/customers/${customerId}.json`, {
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN
    }
  });

  const tags = customerRes.data.customer.tags.split(', ');
  if (!tags.includes('age_verified')) return res.status(200).send("Not verified");

  // Calculate points
  let points = Math.floor(orderTotal / 10);
  if (tags.find(tag => tag.startsWith('referrer-'))) {
    points += Math.floor(points * 0.05);
  }

  // Get existing points metafield (optional, can overwrite instead)
  const metafieldsRes = await axios.get(`https://${SHOPIFY_STORE}/admin/api/2024-04/customers/${customerId}/metafields.json`, {
    headers: {
      'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN
    }
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

  // Update or create metafield
  if (pointsMetafieldId) {
    await axios.put(`https://${SHOPIFY_STORE}/admin/api/2024-04/metafields/${pointsMetafieldId}.json`, {
      metafield: {
        value: newTotal,
        type: 'number_integer'
      }
    }, {
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN
      }
    });
  } else {
    await axios.post(`https://${SHOPIFY_STORE}/admin/api/2024-04/customers/${customerId}/metafields.json`, {
      metafield: {
        namespace: 'loyalty',
        key: 'points',
        value: newTotal,
        type: 'number_integer'
      }
    }, {
      headers: {
        'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN
      }
    });
  }

  return res.status(200).send("Points added");
});

app.listen(3000, () => {
  console.log("Listening on port 3000");
});