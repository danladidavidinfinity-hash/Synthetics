// tick.js — Netlify serverless function
// Connects to Deriv WebSocket from Netlify's server (not the user's browser)
// Returns latest tick price as plain JSON over HTTPS

const WebSocket = require('ws')

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'Content-Type',
  'Content-Type': 'application/json',
}

const APP_ID = '32CU4vIdad1kjw93ULFI8'
const TOKEN  = process.env.DERIV_TOKEN

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: CORS, body: '' }
  }

  const symbol = (event.queryStringParameters || {}).symbol || 'BOOM500'

  if (!TOKEN) {
    return {
      statusCode: 500,
      headers: CORS,
      body: JSON.stringify({ error: 'DERIV_TOKEN environment variable is not set in Netlify.' })
    }
  }

  return new Promise((resolve) => {
    let settled = false
    const done = (body, status = 200) => {
      if (settled) return
      settled = true
      try { ws.terminate() } catch (_) {}
      resolve({ statusCode: status, headers: CORS, body: JSON.stringify(body) })
    }

    // Hard timeout — Netlify functions max out at 10s
    const timer = setTimeout(() => done({ error: 'Deriv connection timed out after 9s' }, 504), 9000)

    let ws
    try {
      ws = new WebSocket(`wss://ws.derivws.com/websockets/v3?app_id=${APP_ID}`)
    } catch (e) {
      clearTimeout(timer)
      return resolve({ statusCode: 500, headers: CORS, body: JSON.stringify({ error: 'WS init: ' + e.message }) })
    }

    ws.on('open', () => {
      ws.send(JSON.stringify({ authorize: TOKEN }))
    })

    ws.on('message', (raw) => {
      let data
      try { data = JSON.parse(raw) } catch (e) {
        clearTimeout(timer); done({ error: 'parse error: ' + e.message }, 500); return
      }

      if (data.msg_type === 'authorize') {
        if (data.error) { clearTimeout(timer); done({ error: 'auth: ' + data.error.message }, 401); return }
        // Authorized — request ONE tick (no subscribe, just a snapshot)
        ws.send(JSON.stringify({ ticks: symbol }))
      }

      if (data.msg_type === 'tick') {
        clearTimeout(timer)
        done({
          ok: true,
          symbol: data.tick.symbol,
          price: data.tick.quote,
          epoch: data.tick.epoch
        })
      }

      if (data.error && data.msg_type !== 'authorize') {
        clearTimeout(timer)
        done({ error: `[${data.msg_type}] ${data.error.message}` }, 400)
      }
    })

    ws.on('error', (e) => { clearTimeout(timer); done({ error: 'ws error: ' + e.message }, 502) })
    ws.on('close', (code) => { clearTimeout(timer); if (!settled) done({ error: 'ws closed: code ' + code }, 502) })
  })
}
