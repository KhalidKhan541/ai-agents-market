// Cloudflare Worker Backend API Gateway & Portal Server
// Bound to D1 Database (env.DB)

export default {
    async fetch(request, env, ctx) {
        const url = new URL(request.url);
        const path = url.pathname;
        const method = request.method;

        // CORS Headers Configuration
        const corsHeaders = {
            'Access-Control-Allow-Origin': '*',
            'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
            'Access-Control-Allow-Headers': 'Content-Type, X-Agent-API-Key',
        };

        if (method === 'OPTIONS') {
            return new Response(null, { headers: corsHeaders });
        }

        try {
            // ROUTER SECTION

            // 1. REGISTER
            if (path === '/api/auth/register' && method === 'POST') {
                const { email, password } = await request.json();
                if (!email || !password) {
                    return jsonResponse({ error: 'Email and password required' }, 400, corsHeaders);
                }

                // Check if user exists
                const existing = await env.DB.prepare('SELECT id FROM users WHERE LOWER(email) = LOWER(?)')
                    .bind(email)
                    .first();
                if (existing) {
                    return jsonResponse({ error: 'Account already exists' }, 400, corsHeaders);
                }

                const userId = 'dev_user_' + Date.now();
                const apiKey = 'agent_key_' + Math.random().toString(36).substring(2, 10) + Math.random().toString(36).substring(2, 10);
                
                await env.DB.prepare('INSERT INTO users (id, email, password, apiKey, balance, isAdmin) VALUES (?, ?, ?, ?, ?, 0)')
                    .bind(userId, email, password, apiKey, 100.0) // 100 PKR registration bonus
                    .run();

                const user = { id: userId, email, apiKey, balance: 100.0, isAdmin: 0 };
                return jsonResponse({ message: 'Success', user }, 200, corsHeaders);
            }

            // 2. LOGIN
            if (path === '/api/auth/login' && method === 'POST') {
                const { email, password } = await request.json();
                if (!email || !password) {
                    return jsonResponse({ error: 'Email and password required' }, 400, corsHeaders);
                }

                const user = await env.DB.prepare('SELECT id, email, apiKey, balance, isAdmin, password FROM users WHERE LOWER(email) = LOWER(?)')
                    .bind(email)
                    .first();

                if (!user || user.password !== password) {
                    return jsonResponse({ error: 'Invalid email or password' }, 401, corsHeaders);
                }

                // Remove password from returned data
                delete user.password;
                
                // Get purchased API lists
                const subs = await env.DB.prepare('SELECT api_name FROM user_subscriptions WHERE user_id = ?')
                    .bind(user.id)
                    .all();
                user.purchasedApis = subs.results.map(r => r.api_name);

                return jsonResponse({ message: 'Success', user }, 200, corsHeaders);
            }

            // 3. GET SYSTEM APIS
            if (path === '/api/apis' && method === 'GET') {
                const apis = await env.DB.prepare('SELECT * FROM apis').all();
                return jsonResponse(apis.results, 200, corsHeaders);
            }

            // 4. BUY PREMIUM API ACCESS
            if (path === '/api/purchase' && method === 'POST') {
                const { userId, apiName } = await request.json();
                
                // Verify user and balance
                const user = await env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(userId).first();
                const api = await env.DB.prepare('SELECT * FROM apis WHERE name = ?').bind(apiName).first();

                if (!user || !api) {
                    return jsonResponse({ error: 'User or API not found' }, 404, corsHeaders);
                }

                // standard/pro flat rate unlock cost
                const unlockCost = api.tier === 'Standard' ? 10.00 : 50.00;
                if (user.balance < unlockCost) {
                    return jsonResponse({ error: 'Insufficient balance' }, 402, corsHeaders);
                }

                // Deduct balance and insert subscription record inside transaction
                await env.DB.batch([
                    env.DB.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').bind(unlockCost, userId),
                    env.DB.prepare('INSERT OR IGNORE INTO user_subscriptions (user_id, api_name) VALUES (?, ?)').bind(userId, apiName)
                ]);

                return jsonResponse({ message: 'Purchase successful', balance: user.balance - unlockCost }, 200, corsHeaders);
            }

            // 5. POST PAYMENT TOPUP
            if (path === '/api/topup' && method === 'POST') {
                const { userEmail, amount, orderId, refNumber } = await request.json();
                
                await env.DB.prepare('INSERT INTO payments (orderId, user_email, amount, status, ref_number, timestamp) VALUES (?, ?, ?, ?, ?, ?)')
                    .bind(orderId, userEmail, amount, 'pending', refNumber || '', new Date().toISOString())
                    .run();

                return jsonResponse({ message: 'Payment receipt queued' }, 200, corsHeaders);
            }

            // 6. SECURE API PROXY GATEWAY ROUTER (THE ENFORCER)
            if (path.startsWith('/api/proxy/')) {
                const apiName = decodeURIComponent(path.substring(11)).replace(/_/g, ' ');
                const apiKeyHeader = request.headers.get('X-Agent-API-Key');

                if (!apiKeyHeader) {
                    return jsonResponse({ error: 'Forbidden: Missing X-Agent-API-Key header' }, 403, corsHeaders);
                }

                // Authenticate user via API key
                const user = await env.DB.prepare('SELECT * FROM users WHERE apiKey = ?').bind(apiKeyHeader).first();
                if (!user) {
                    return jsonResponse({ error: 'Forbidden: Invalid API key' }, 403, corsHeaders);
                }

                // Find destination API configuration
                const api = await env.DB.prepare('SELECT * FROM apis WHERE name = ?').bind(apiName).first();
                if (!api) {
                    return jsonResponse({ error: 'API endpoint not found in catalog' }, 404, corsHeaders);
                }

                if (!api.is_active) {
                    return jsonResponse({ error: 'API endpoint currently offline' }, 503, corsHeaders);
                }

                // Check API subscription access (Admin skips subscription requirement)
                if (api.tier !== 'Free' && !user.isAdmin) {
                    const isSubscribed = await env.DB.prepare('SELECT 1 FROM user_subscriptions WHERE user_id = ? AND api_name = ?')
                        .bind(user.id, apiName)
                        .first();
                    if (!isSubscribed) {
                        return jsonResponse({ error: 'Payment Required: Please subscribe to this API in the marketplace dashboard' }, 403, corsHeaders);
                    }
                }

                // Check wallet balance
                const cost = api.price_per_call;
                if (user.balance < cost) {
                    // Log failed transaction call due to payment
                    await logCall(env.DB, user.email, api.name, 402, cost);
                    return jsonResponse({ 
                        error: 'Payment Required: Wallet balance below per-call price',
                        required_balance_pkr: cost,
                        current_balance_pkr: user.balance
                    }, 402, corsHeaders);
                }

                // Deduct cost and save to DB
                await env.DB.prepare('UPDATE users SET balance = balance - ? WHERE id = ?').bind(cost, user.id).run();

                // Log call as success
                await logCall(env.DB, user.email, api.name, 200, cost);

                // Return Gateway mock data payload or execute fetch
                const responseData = api.mock_response || JSON.stringify({ gateway_status: 'OK', api: apiName });
                
                // Return response decorated with billing parameters
                const customHeaders = {
                    ...corsHeaders,
                    'Content-Type': 'application/json',
                    'X-Proxy-Cost': `${cost.toFixed(2)} PKR`,
                    'X-Agent-Remaining-Balance': `${(user.balance - cost).toFixed(2)} PKR`
                };

                return new Response(responseData, { status: 200, headers: customHeaders });
            }

            // 7. ADMIN ENDPOINTS

            // GET ADMIN OVERVIEW
            if (path === '/api/admin/overview' && method === 'GET') {
                const revenueResult = await env.DB.prepare('SELECT SUM(amount) as total FROM payments WHERE status = "approved"').first();
                const totalRevenue = revenueResult.total || 0;

                const usersCountResult = await env.DB.prepare('SELECT COUNT(*) as count FROM users WHERE isAdmin = 0').first();
                const totalUsers = usersCountResult.count || 0;

                const paymentsCountResult = await env.DB.prepare('SELECT COUNT(*) as count FROM payments WHERE status = "pending"').first();
                const pendingPayments = paymentsCountResult.count || 0;

                const logsCountResult = await env.DB.prepare('SELECT COUNT(*) as count FROM logs').first();
                const totalCalls = logsCountResult.count || 0;

                return jsonResponse({
                    revenue: totalRevenue,
                    users: totalUsers,
                    pending: pendingPayments,
                    calls: totalCalls
                }, 200, corsHeaders);
            }

            // GET ADMIN PAYMENTS QUEUE
            if (path === '/api/admin/payments' && method === 'GET') {
                const payments = await env.DB.prepare('SELECT * FROM payments ORDER BY timestamp DESC').all();
                return jsonResponse(payments.results, 200, corsHeaders);
            }

            // POST APPROVE PAYMENT
            if (path === '/api/admin/payments/approve' && method === 'POST') {
                const { orderId } = await request.json();
                const payment = await env.DB.prepare('SELECT * FROM payments WHERE orderId = ?').bind(orderId).first();

                if (!payment || payment.status !== 'pending') {
                    return jsonResponse({ error: 'Receipt not pending verification' }, 400, corsHeaders);
                }

                // Add balance to user & mark approved
                await env.DB.batch([
                    env.DB.prepare('UPDATE users SET balance = balance + ? WHERE LOWER(email) = LOWER(?)').bind(payment.amount, payment.user_email),
                    env.DB.prepare('UPDATE payments SET status = "approved" WHERE orderId = ?').bind(orderId)
                ]);

                return jsonResponse({ message: 'Payment approved' }, 200, corsHeaders);
            }

            // POST REJECT PAYMENT
            if (path === '/api/admin/payments/reject' && method === 'POST') {
                const { orderId } = await request.json();
                await env.DB.prepare('UPDATE payments SET status = "rejected" WHERE orderId = ?').bind(orderId).run();
                return jsonResponse({ message: 'Payment rejected' }, 200, corsHeaders);
            }

            // GET ADMIN AGENTS TABLE
            if (path === '/api/admin/agents' && method === 'GET') {
                const users = await env.DB.prepare('SELECT id, email, apiKey, balance FROM users WHERE isAdmin = 0').all();
                return jsonResponse(users.results, 200, corsHeaders);
            }

            // POST ADMIN AGENT CREDIT
            if (path === '/api/admin/agents/credit' && method === 'POST') {
                const { userId, amount } = await request.json();
                await env.DB.prepare('UPDATE users SET balance = balance + ? WHERE id = ?').bind(amount, userId).run();
                return jsonResponse({ message: 'Wallet credited successfully' }, 200, corsHeaders);
            }

            // GET ADMIN TRANSACTION LOGS
            if (path === '/api/admin/logs' && method === 'GET') {
                const logs = await env.DB.prepare('SELECT * FROM logs ORDER BY timestamp DESC LIMIT 100').all();
                return jsonResponse(logs.results, 200, corsHeaders);
            }

            // POST ADMIN OVERRIDE CATALOG PRICE
            if (path === '/api/admin/catalog/price' && method === 'POST') {
                const { apiName, price } = await request.json();
                await env.DB.prepare('UPDATE apis SET price_per_call = ? WHERE name = ?').bind(price, apiName).run();
                return jsonResponse({ message: 'API price updated' }, 200, corsHeaders);
            }

            // POST ADMIN BATCH INSERT CATALOG APIS
            if (path === '/api/admin/catalog/batch-insert' && method === 'POST') {
                const { apis } = await request.json();
                if (!apis || !Array.isArray(apis)) {
                    return jsonResponse({ error: 'Invalid payload: apis array required' }, 400, corsHeaders);
                }

                const statements = apis.map(api => {
                    return env.DB.prepare('INSERT OR REPLACE INTO apis (name, category, description, url, auth, https, cors, tier, price_per_call, is_active, mock_response) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
                        .bind(
                            api.name,
                            api.category,
                            api.description,
                            api.url,
                            api.auth,
                            api.https,
                            api.cors,
                            api.tier,
                            api.price_per_call,
                            api.is_active ? 1 : 0,
                            api.mock_response || null
                        );
                });

                await env.DB.batch(statements);
                return jsonResponse({ message: `Successfully inserted batch of ${apis.length} APIs` }, 200, corsHeaders);
            }

            return jsonResponse({ error: 'Endpoint route not found' }, 404, corsHeaders);

        } catch (err) {
            return jsonResponse({ error: err.message || 'Server Exception' }, 500, corsHeaders);
        }
    }
};

// Response Helpers
function jsonResponse(data, status = 200, headers = {}) {
    return new Response(JSON.stringify(data), {
        status,
        headers: {
            ...headers,
            'Content-Type': 'application/json',
        }
    });
}

// Log execution logger Helper
async function logCall(db, email, apiName, statusCode, cost) {
    const logId = 'log_' + Date.now() + Math.random().toString(36).substring(2, 5);
    await db.prepare('INSERT INTO logs (id, user_email, api_name, status_code, cost, timestamp) VALUES (?, ?, ?, ?, ?, ?)')
        .bind(logId, email, apiName, statusCode, cost, new Date().toISOString())
        .run();
}
