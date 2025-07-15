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
app.post('/webhook/orders/fulfilled', async (req, res) => {
  console.log('✅ Fulfillment webhook triggered');
  const order = req.body;
  const customerId = order?.customer?.id;

  if (!customerId) return res.status(400).send('Missing customer ID');

  try {
    // Get Customer Info
    const { data: customerData } = await axios.get(
      `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/customers/${customerId}.json`,
      { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } }
    );
    const customer = customerData.customer;
    const note = customer.note || '';
    const lineItems = order.line_items || [];

    // --- LOYALTY POINTS FOR CUSTOMER ---
    let totalPoints = 0;
    for (const item of lineItems) {
      try {
        const { data: productData } = await axios.get(
          `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/products/${item.product_id}/metafields.json`,
          { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } }
        );
        const pointsField = productData.metafields.find(
          mf => mf.namespace === 'loyalty' && mf.key === 'points'
        );
        const points = parseInt(pointsField?.value || '0');
        totalPoints += points * item.quantity;
      } catch (err) {
        console.warn(`⚠️ Error getting product metafields for ${item.product_id}:`, err.message);
      }
    }

    // Update Customer Points
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

    const newTotal = current + totalPoints;
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

    console.log(`💰 Loyalty Points: +${totalPoints} → Customer ID ${customerId}`);

    // --- REFERRAL / COMMISSION LOGIC ---
    const refMatch = note.match(/ref:(\d+)/);
    if (!refMatch) return res.status(200).send('No referral found');
    const refCode = refMatch[1];

    const referrer = await getReferrerByCode(refCode, customerId);
    if (!referrer) return res.status(200).send('Referrer not found');

    const referrerTags = referrer.tags?.split(',').map(t => t.trim()) || [];
    if (!referrerTags.includes('affiliate')) {
      console.log(`❌ Referrer ID ${referrer.id} is not an affiliate`);
      return res.status(200).send('Referrer is not affiliate');
    }

    // --- COMMISSION CALCULATION ---
    let commissionTotal = 0;
    for (const item of lineItems) {
      try {
        const { data: productData } = await axios.get(
          `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/products/${item.product_id}/metafields.json`,
          { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } }
        );
        const commissionField = productData.metafields.find(
          mf => mf.namespace === 'commission' && mf.key === 'referrer'
        );
        const commission = parseFloat(commissionField?.value || '0');
        commissionTotal += commission * item.quantity;
      } catch (err) {
        console.warn(`⚠️ Error getting commission for product ${item.product_id}:`, err.message);
      }
    }

    if (commissionTotal > 0) {
      // --- Update Referrer Loyalty Points ---
      const { data: refMeta } = await axios.get(
        `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/customers/${referrer.id}/metafields.json`,
        { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } }
      );

      let refPoints = 0, refMid = null, rewardedCount = 0, rewardedCountId = null;
      for (const mf of refMeta.metafields) {
        if (mf.namespace === 'loyalty' && mf.key === 'points') {
          refPoints = parseInt(mf.value) || 0;
          refMid = mf.id;
        }
        if (mf.namespace === 'referral' && mf.key === 'rewarded_count') {
          rewardedCount = parseInt(mf.value) || 0;
          rewardedCountId = mf.id;
          console.log(rewardedCountId);
        }
      }

      // ⛔ Limit: max 5 rewards
      if (rewardedCount >= 5) {
        console.log(`🔒 Referrer ID ${referrer.id} has already reached 5 referrals. Skipping reward.`);
        return res.status(200).send('Referrer reached max reward limit');
      }

      // Award Commission Points
      const refPayload = {
        metafield: {
          namespace: 'loyalty',
          key: 'points',
          value: Math.floor(refPoints + commissionTotal),
          type: 'number_integer'
        }
      };

      if (refMid) {
        await axios.put(
          `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/metafields/${refMid}.json`,
          refPayload,
          { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } }
        );
      } else {
        await axios.post(
          `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/customers/${referrer.id}/metafields.json`,
          refPayload,
          { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } }
        );
      }

      console.log(`🎯 Commission: +${Math.floor(commissionTotal)} pts → Referrer ID ${referrer.id}`);

      // Update Referral Count
      const newCountPayload = {
        metafield: {
          namespace: 'referral',
          key: 'rewarded_count',
          value: String(rewardedCount + 1),
          type: 'number_integer'
        }
      };

      if (rewardedCountId) {
        await axios.put(
          `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/metafields/${rewardedCountId}.json`,
          newCountPayload,
          { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } }
        );
      } else {
        await axios.post(
          `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/customers/${referrer.id}/metafields.json`,
          newCountPayload,
          { headers: { 'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN } }
        );
      }

      console.log(`✅ Referrer ID ${referrer.id} rewarded referral count updated to ${rewardedCount + 1}`);
    }

    return res.status(200).send('Webhook processed');
  } catch (err) {
    console.error('❌ Fulfillment error:', err.response?.data || err.message);
    return res.status(500).send('Internal error');
  }
});




/* ------------------ Validate the referral code ------------------ */
// Endpoint: /apps/referral/check-code?code=123456
app.get('/apps/referral/check-code', async (req, res) => {
  const codeToCheck = req.query.code;

  if (!codeToCheck) {
    return res.status(400).json({ valid: false, message: 'No code provided' });
  }

  let found = false;
  let nextPageInfo = null;

  try {
    do {
      const customerUrl = `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/customers.json?limit=50${
        nextPageInfo ? `&page_info=${nextPageInfo}` : ''
      }`;

      const customerRes = await axios.get(customerUrl, {
        headers: {
          'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
        },
      });

      const customers = customerRes.data.customers;
      if (!customers || customers.length === 0) break;

      for (const customer of customers) {
        try {
          const metafieldsRes = await axios.get(
            `https://${SHOPIFY_STORE}/admin/api/${API_VERSION}/customers/${customer.id}/metafields.json`,
            {
              headers: {
                'X-Shopify-Access-Token': SHOPIFY_ACCESS_TOKEN,
              },
            }
          );

          const match = metafieldsRes.data.metafields.find(
            (mf) =>
              mf.namespace === 'referral' &&
              mf.key === 'code' &&
              mf.value === codeToCheck
          );

          if (match) {
            found = true;
            return res.json({ valid: true, customer_id: customer.id });
          }
        } catch (err) {
          console.error(`Metafields error for customer ${customer.id}:`, err.message);
        }
      }

      // Parse next page from Link header
      const linkHeader = customerRes.headers['link'];
      const matchNext = linkHeader && linkHeader.match(/<([^>]+)>;\s*rel="next"/);

      if (matchNext) {
        const url = new URL(matchNext[1]);
        nextPageInfo = url.searchParams.get('page_info');
      } else {
        nextPageInfo = null;
      }

    } while (!found && nextPageInfo);

    return res.json({ valid: false });
  } catch (error) {
    console.error('Error checking referral code:', error.response?.data || error.message);
    return res.status(500).json({ valid: false, error: error.message });
  }
});






/* ------------------ Start Server ------------------ */
app.listen(3000, () => console.log('🚀 Webhook server running on port 3000'));