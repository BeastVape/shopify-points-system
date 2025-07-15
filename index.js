const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN;
const SHOPIFY_STORE = 'j0f9pj-rd.myshopify.com';
const API_VERSION = '2024-04';

app.use(cors());
app.use(bodyParser.json());


/* ------------------ Helper: Generate and Fix Referral Code ------------------ */
function generateReferralCode(customerId) {
  return `${customerId}`;
}
async function ensureReferralCode(customer) {
  const metasUrl = `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/customers/${customer.id}/metafields.json`;
  const res = await axios.get(metasUrl, {
    headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN }
  });

  let found = false;
  for (const mf of res.data.metafields) {
    if (mf.namespace === 'referral' && mf.key === 'code') {
      found = true;
      if (mf.value !== `${customer.id}`) {
        await axios.put(
          `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/metafields/${mf.id}.json`,
          {
            metafield: {
              namespace: 'referral',
              key: 'code',
              value: `${customer.id}`,
              type: 'single_line_text_field'
            }
          },
          { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } }
        );
      }
    }
  }

  if (!found) {
    await axios.post(
      metasUrl,
      {
        metafield: {
          namespace: 'referral',
          key: 'code',
          value: `${customer.id}`,
          type: 'single_line_text_field'
        }
      },
      { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } }
    );
  }

  const tags = customer.tags?.split(',').map(t => t.trim()) || [];
  const tag = `referrer-${customer.id}`;
  if (!tags.includes(tag)) {
    await axios.put(
      `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/customers/${customer.id}.json`,
      {
        customer: {
          id: customer.id,
          tags: [...tags, tag].join(', ')
        }
      },
      { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } }
    );
  }
}
/* ------------------ Helper: Find referrer by code ------------------ */
async function getReferrerByCode(refCode, excludeId = null) {
  const query = `metafield:referral.code=${refCode}`;
  const url = `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/customers/search.json?query=${encodeURIComponent(query)}`;
  
  const res = await axios.get(url, {
    headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN }
  });

  const candidates = res.data.customers || [];

  // Only reward the one whose ID exactly matches the referral code
  const referrer = candidates.find(c => String(c.id) === String(refCode));

  if (referrer && String(referrer.id) !== String(excludeId)) {
    return referrer;
  }

  return null;
}
/* ------------------ Webhook: customers/update ------------------ */
app.post('/webhook/customers/update', async (req, res) => {
  const customerId = req.body.id;
  console.log(`✅ customers/update webhook triggered for ID: ${customerId}`);

  try {
    // Get full customer data
    const response = await axios.get(
      `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/customers/${customerId}.json`,
      { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } }
    );

    const customer = response.data?.customer;
    if (!customer) {
      console.error('❌ Customer not found in Shopify response:', response.data);
      return res.status(500).send('Customer not found');
    }

    const tags = customer.tags?.split(',').map(t => t.trim()) || [];
    const note = customer.note || '';

    // Ensure this customer has a referral code metafield + tag
    await ensureReferralCode(customer);

    // Exit if not verified or already rewarded
    if (!tags.includes('age_verified') || tags.includes('referral_rewarded')) {
      return res.status(200).send('No action needed');
    }

    // Extract referral code from note
    const refMatch = note.match(/ref:(\d+)/);
    if (!refMatch) return res.status(200).send('No referral code found');
    const refCode = refMatch[1];

    // Find the actual referrer (must match ID exactly)
    const referrer = await getReferrerByCode(refCode, customerId);
    if (!referrer) {
      console.warn(`⚠️ Referrer with code ${refCode} not found`);
      return res.status(200).send('Referrer not found');
    }

    // Fetch current referrer's loyalty points
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

    const newPoints = String(current + 10);
    const payload = {
      metafield: {
        namespace: 'loyalty',
        key: 'points',
        value: newPoints,
        type: 'number_integer'
      }
    };

    let pointsRes;
    if (mId) {
      pointsRes = await axios.put(
        `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/metafields/${mId}.json`,
        payload,
        { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } }
      );
    } else {
      pointsRes = await axios.post(
        `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/customers/${referrer.id}/metafields.json`,
        payload,
        { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } }
      );
    }

    console.log('✅ Loyalty points updated:', pointsRes.data);

    // Add "referral_rewarded" tag to avoid double reward
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

    console.log(`🎉 Referral reward granted: 10 points → Referrer ID: ${referrer.id}`);
    return res.status(200).send('Referral rewarded');
  } catch (err) {
    console.error('❌ customers/update error:', err.response?.data || err.message);
    return res.status(500).send('Internal server error');
  }
});
/* ------------------ Webhook: orders ------------------ */
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
/* ------------------ Webhook: orders/fulfilled ------------------ */
app.post('/webhook/orders/fulfilled', async (req, res) => {
  console.log('✅ Fulfillment webhook triggered');
  console.log('📦 Webhook Payload:', JSON.stringify(req.body, null, 2));

  const order = req.body;
  const customerId = order?.customer?.id;
  if (!customerId) {
    console.error('❌ Missing customer ID in order');
    return res.status(400).send('Missing customer ID');
  }

  try {
    const { data: customerData } = await axios.get(
      `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/customers/${customerId}.json`,
      { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } }
    );
    const customer = customerData.customer;
    const tags = customer.tags?.split(',').map(t => t.trim()) || [];
    const note = customer.note || '';

    console.log('🧾 Customer ID:', customerId);
    console.log('🗒️ Note field:', note);

    const refMatch = note.match(/ref:(\d+)/);
    if (!refMatch) {
      console.warn('⚠️ No referrer code found in customer note');
      return res.status(200).send('No referrer');
    }

    const refCode = refMatch[1];
    const referrer = await getReferrerByCode(refCode, customerId);
    if (!referrer) {
      console.warn('⚠️ Referrer not found for code:', refCode);
      return res.status(200).send('No referrer found');
    }

    console.log('👥 Referrer ID:', referrer.id);

    // Calculate commission
    let commissionTotal = 0;
    for (const item of order.line_items) {
      console.log(`🔍 Checking product ID ${item.product_id} x${item.quantity}`);
      try {
        const { data: productData } = await axios.get(
          `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/products/${item.product_id}/metafields.json`,
          { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } }
        );

        const mf = productData.metafields.find(
          m => m.namespace === 'commission' && m.key === 'referrer'
        );

        if (mf) {
          const value = parseFloat(mf.value || '0');
          const total = value * item.quantity;
          commissionTotal += total;
          console.log(`✅ Found commission metafield: ${value} x${item.quantity} = ${total}`);
        } else {
          console.warn(`❌ No commission metafield found for product ${item.product_id}`);
        }
      } catch (err) {
        console.warn(`❌ Error reading metafields for product ${item.product_id}:`, err.response?.data || err.message);
      }
    }

    if (commissionTotal === 0) {
      console.warn('⚠️ No commission calculated from any products');
      return res.status(200).send('No commission to reward');
    }

    console.log(`💸 Commission to award: ${Math.floor(commissionTotal)} points`);

    // Update referrer's points
    const { data: metaData } = await axios.get(
      `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/customers/${referrer.id}/metafields.json`,
      { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } }
    );

    let current = 0, mId = null;
    for (const mf of metaData.metafields) {
      if (mf.namespace === 'loyalty' && mf.key === 'points') {
        current = parseInt(mf.value) || 0;
        mId = mf.id;
      }
    }

    const payload = {
      metafield: {
        namespace: 'loyalty',
        key: 'points',
        value: Math.floor(current + commissionTotal),
        type: 'number_integer'
      }
    };

    if (mId) {
      console.log(`🛠 Updating existing loyalty metafield ID ${mId} → ${payload.metafield.value}`);
      await axios.put(
        `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/metafields/${mId}.json`,
        payload,
        { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } }
      );
    } else {
      console.log(`➕ Creating new loyalty metafield with value ${payload.metafield.value}`);
      await axios.post(
        `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/customers/${referrer.id}/metafields.json`,
        payload,
        { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } }
      );
    }

    console.log(`🎯 Fulfilled Referral: +${Math.floor(commissionTotal)} pts → Referrer ID: ${referrer.id}`);
    res.status(200).send('Commission rewarded');
  } catch (err) {
    console.error('❌ Fulfillment error:', err.response?.data || err.message);
    res.status(500).send('Error processing fulfilled order');
  }
});

/* ------------------ Validate the referral code ------------------ */
// Endpoint: /apps/referral/check-code?code=123456
app.get('/apps/referral/check-code', async (req, res) => {
  const codeToCheck = req.query.code;

  if (!codeToCheck) {
    return res.status(400).json({ valid: false, message: 'No code provided' });
  }

  try {
    // Get all customers (or use pagination if needed)
    const customersResponse = await axios.get(
      `https://${SHOP}/admin/api/2024-01/customers.json`,
      {
        headers: {
          'X-Shopify-Access-Token': ADMIN_API_ACCESS_TOKEN,
          'Content-Type': 'application/json',
        },
      }
    );

    const customers = customersResponse.data.customers;

    // Loop through each customer to check their metafields
    for (const customer of customers) {
      const metafieldsResponse = await axios.get(
        `https://${SHOP}/admin/api/2024-01/customers/${customer.id}/metafields.json`,
        {
          headers: {
            'X-Shopify-Access-Token': ADMIN_API_ACCESS_TOKEN,
          },
        }
      );

      const referralMetafield = metafieldsResponse.data.metafields.find(
        (mf) =>
          mf.namespace === 'referral' &&
          mf.key === 'code' &&
          mf.value === codeToCheck
      );

      if (referralMetafield) {
        return res.json({ valid: true });
      }
    }

    return res.json({ valid: false });
  } catch (error) {
    console.error('Error checking referral code:', error.message);
    return res.status(500).json({ valid: false, error: error.message });
  }
});




/* ------------------ Start Server ------------------ */
app.listen(3000, () => console.log('🚀 Webhook server running on port 3000'));