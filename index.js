const express = require('express');
const bodyParser = require('body-parser');
const axios = require('axios');
const app = express();

const SHOPIFY_ACCESS_TOKEN = process.env.SHOPIFY_ACCESS_TOKEN || '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';
const SHOPIFY_STORE        = 'j0f9pj-rd.myshopify.com';
const API_VERSION          = '2024-04';

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

    await ensureReferralCode(customer);

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

/* ------------------ Start Server ------------------ */
app.listen(3000, () => console.log('🚀 Webhook server running on port 3000'));
