import express from 'express';
import cors from 'cors';
import bodyParser from 'body-parser';
import dotenv from 'dotenv';
import cron from 'node-cron';
import { TBankAutomation } from './tbank-automation.js';
import { AlfaAutomation } from './alfa-automation.js';
import { EncryptionService } from './encryption.js';
import { SessionManager } from './session-manager.js';
import { SimpleScheduler } from './simple-scheduler.js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Middleware
app.use(cors());

// Custom JSON parser that sanitizes control characters from SMS messages
app.use(bodyParser.text({ type: 'application/json' }));
app.use((req, res, next) => {
  if (req.body && typeof req.body === 'string') {
    try {
      // Store original for debugging
      req.rawBody = req.body;

      // Sanitize control characters (newlines, tabs, etc.) from JSON string
      // This is needed because MacroDroid sends SMS with unescaped newlines
      const sanitized = req.body
        .replace(/\r\n/g, ' ')  // Windows line endings
        .replace(/\n/g, ' ')     // Unix line endings
        .replace(/\r/g, ' ')     // Old Mac line endings
        .replace(/\t/g, ' ')     // Tabs
        .replace(/\s+/g, ' ');   // Multiple spaces to single space

      req.body = JSON.parse(sanitized);
      next();
    } catch (e) {
      console.error('[BODY-PARSER] ❌ JSON Parse Error:', e.message);
      console.error('[BODY-PARSER] ❌ Raw body:', req.rawBody ? req.rawBody.substring(0, 500) : 'N/A');
      console.error('[BODY-PARSER] ❌ Content-Type:', req.headers['content-type']);

      return res.status(400).json({
        success: false,
        error: 'Invalid JSON in request body',
        details: e.message
      });
    }
  } else {
    next();
  }
});

app.use(bodyParser.urlencoded({ extended: true }));

// Services
const encryptionService = new EncryptionService(process.env.ENCRYPTION_SECRET_KEY || process.env.ENCRYPTION_KEY);
const sessionManager = new SessionManager();
let simpleScheduler = null;

// SMS code queue - stores codes that arrived before session was ready
const smsCodeQueue = new Map(); // username -> { code, timestamp }

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// Ping endpoint for external heartbeat (prevents Render free tier sleep)
// Also checks session health and takes screenshots
app.get('/ping', async (req, res) => {
  const timestamp = new Date().toISOString();
  console.log(`[PING] Health check at ${timestamp}`);

  const sessionCount = sessionManager.getSessionCount();
  const sessionHealth = [];

  // Check health of all active sessions
  for (const [sessionId, session] of sessionManager.sessions.entries()) {
    if (session.authenticated && session.automation) {
      try {
        console.log(`[PING] Checking session ${sessionId} for user ${session.username}`);

        // Take screenshot of each active session
        await session.automation.takeDebugScreenshot(`ping-${timestamp}`);

        // Get session stats
        const stats = session.automation.getSessionStats();

        sessionHealth.push({
          sessionId,
          username: session.username,
          lifetimeMinutes: stats.lifetimeMinutes,
          healthy: true
        });

        console.log(`[PING] ✅ Session ${sessionId} healthy (lifetime: ${stats.lifetimeMinutes} min)`);
      } catch (error) {
        console.error(`[PING] ❌ Session ${sessionId} error:`, error.message);
        sessionHealth.push({
          sessionId,
          username: session.username,
          healthy: false,
          error: error.message
        });
      }
    }
  }

  res.json({
    status: 'alive',
    timestamp,
    activeSessions: sessionCount,
    sessionHealth
  });
});

/**
 * Authenticate user and create session
 * POST /api/auth/login
 * Body: { username, phone, password }
 */
/**
 * Auto-submit SMS code from MacroDroid
 * POST /api/auth/auto-sms
 * Body: { message: "Никому не говорите код 4399. Вход в Т-Банк..." }
 */
app.post('/api/auth/auto-sms', async (req, res) => {
  try {
    const { message, username } = req.body;

    if (!message) {
      return res.status(400).json({
        success: false,
        error: 'Missing message'
      });
    }

    console.log('[AUTO-SMS] Received SMS message:', message);

    // Extract code using regex (4 digits)
    const codeMatch = message.match(/код\s+(\d{4})/i);

    if (!codeMatch) {
      console.log('[AUTO-SMS] No code found in message');
      return res.status(400).json({
        success: false,
        error: 'Could not extract code from message'
      });
    }

    const code = codeMatch[1];
    console.log(`[AUTO-SMS] Extracted code: ${code}`);

    // Find active session waiting for SMS
    let targetSession = null;

    if (username) {
      // If username provided, find by username
      const sessionId = sessionManager.findSessionByUsername(username);
      if (sessionId) {
        targetSession = sessionManager.getSession(sessionId);
      }
    } else {
      // Otherwise find any session waiting for SMS
      for (const [sessionId, session] of sessionManager.sessions.entries()) {
        if (session.automation.getPendingInputType() === 'sms') {
          targetSession = session;
          break;
        }
      }
    }

    if (!targetSession) {
      console.log('[AUTO-SMS] No session waiting for SMS code yet - adding to queue');

      // Store code in queue with 5-minute TTL
      if (username) {
        smsCodeQueue.set(username, {
          code,
          timestamp: Date.now(),
          expiresAt: Date.now() + 5 * 60 * 1000 // 5 minutes
        });
        console.log(`[AUTO-SMS] Code ${code} queued for user ${username}, will expire in 5 minutes`);

        return res.json({
          success: true,
          message: 'SMS code queued, will be submitted when session is ready',
          code: code,
          queued: true
        });
      } else {
        // No username provided and no active session
        return res.status(404).json({
          success: false,
          error: 'No active session waiting for SMS code and no username provided'
        });
      }
    }

    // Submit the code immediately
    console.log('[AUTO-SMS] Submitting code to session immediately');
    targetSession.automation.submitUserInput(code);

    // Clear from queue if it was there
    if (username) {
      smsCodeQueue.delete(username);
    }

    res.json({
      success: true,
      message: 'SMS code submitted successfully',
      code: code
    });

  } catch (error) {
    console.error('[AUTO-SMS] Error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Auto-submit SMS code from MacroDroid for Alfa-Bank
 * POST /api/auth/auto-sms-alfa
 * Body: { message: "Код для входа в Альфа-Онлайн: 2833. Никому его не сообщайте", username }
 */
app.post('/api/auth/auto-sms-alfa', async (req, res) => {
  try {
    const { message, username } = req.body;

    if (!message) {
      return res.status(400).json({
        success: false,
        error: 'Missing message'
      });
    }

    console.log('[AUTO-SMS-ALFA] Received SMS message:', message);

    // Extract code using regex (4 digits for Alfa)
    // Supports multiple formats:
    // 1. "Код для входа в Альфа-Онлайн: 8105"
    // 2. "Код: 3348. Подтвердите перевод..."
    let codeMatch = message.match(/Код для входа в Альфа-Онлайн:\s*(\d{4})/i);

    if (!codeMatch) {
      // Try alternative format: "Код: 3348"
      codeMatch = message.match(/Код:\s*(\d{4})/i);
    }

    if (!codeMatch) {
      console.log('[AUTO-SMS-ALFA] No code found in message (tried both patterns)');
      return res.status(400).json({
        success: false,
        error: 'Could not extract code from message'
      });
    }

    const code = codeMatch[1];
    console.log(`[AUTO-SMS-ALFA] Extracted code: ${code}`);

    // Determine SMS type based on message content
    const isLoginCode = message.includes('Код для входа в Альфа-Онлайн');
    const isTransferCode = message.includes('Подтвердите перевод');

    const smsType = isLoginCode ? 'login' : (isTransferCode ? 'transfer' : 'unknown');
    console.log(`[AUTO-SMS-ALFA] SMS type detected: ${smsType} (login: ${isLoginCode}, transfer: ${isTransferCode})`);

    // Find active session waiting for Alfa SMS
    let targetSession = null;

    if (username) {
      // If username provided, find by username
      const sessionId = sessionManager.findSessionByUsername(username);
      if (sessionId) {
        targetSession = sessionManager.getSession(sessionId);
      }
    } else {
      // Otherwise find any session waiting for Alfa SMS
      for (const [sessionId, session] of sessionManager.sessions.entries()) {
        // Check if session has alfaAutomation and is waiting for alfa_sms
        if (session.alfaAutomation && session.alfaAutomation.getPendingInputType() === 'alfa_sms') {
          targetSession = session;
          break;
        }
      }
    }

    if (!targetSession) {
      console.log('[AUTO-SMS-ALFA] No session waiting for Alfa SMS code yet - checking queue');

      // Store code in queue with 5-minute TTL (only if not already there)
      if (username) {
        // FIX: Use consistent key format: alfa_{username}_{smsType}
        const queueKey = `alfa_${username}_${smsType}`;
        const existingCode = smsCodeQueue.get(queueKey);

        if (existingCode && existingCode.code === code) {
          console.log(`[AUTO-SMS-ALFA] Code ${code} already in queue, skipping`);
          return res.json({
            success: true,
            message: 'Code already queued',
            code: code,
            queued: true,
            duplicate: true
          });
        }

        smsCodeQueue.set(queueKey, {
          code,
          smsType,
          timestamp: Date.now(),
          expiresAt: Date.now() + 5 * 60 * 1000 // 5 minutes
        });
        console.log(`[AUTO-SMS-ALFA] Code ${code} (type: ${smsType}) queued with key: ${queueKey}, will expire in 5 minutes`);

        return res.json({
          success: true,
          message: 'Alfa SMS code queued, will be submitted when session is ready',
          code: code,
          queued: true
        });
      } else {
        // No username provided and no active session
        return res.status(404).json({
          success: false,
          error: 'No active session waiting for Alfa SMS code and no username provided'
        });
      }
    }

    // Submit the code immediately to Alfa automation
    console.log('[AUTO-SMS-ALFA] Submitting code to Alfa session immediately');
    if (targetSession.alfaAutomation) {
      targetSession.alfaAutomation.submitAlfaSMSCode(code);
    }

    // Clear from queue if it was there
    if (username) {
      const queueKey = `alfa_${username}_${smsType}`;
      smsCodeQueue.delete(queueKey);
      console.log(`[AUTO-SMS-ALFA] Cleared code from queue: ${queueKey}`);
    }

    res.json({
      success: true,
      message: 'Alfa SMS code submitted successfully',
      code: code
    });

  } catch (error) {
    console.error('[AUTO-SMS-ALFA] Error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Get session statistics
 * GET /api/session/stats?sessionId=xxx
 */
app.get('/api/session/stats', (req, res) => {
  try {
    const { sessionId } = req.query;

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        error: 'Missing sessionId'
      });
    }

    const session = sessionManager.getSession(sessionId);
    if (!session) {
      return res.status(404).json({
        success: false,
        error: 'Session not found'
      });
    }

    const stats = session.automation.getSessionStats();

    res.json({
      success: true,
      stats
    });

  } catch (error) {
    console.error('[API] Get session stats error:', error);
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Helper function: Execute evening transfer step 1
async function executeEveningTransferStep1(username) {
  let tbankAutomation = null;
  let smsQueueChecker = null;

  try {
    console.log(`[STEP1] 🌆 Starting T-Bank -> Alfa SBP transfer for ${username}`);

    const FIXED_TBANK_PHONE = process.env.FIXED_TBANK_PHONE;
    const FIXED_ALFA_PHONE = process.env.FIXED_ALFA_PHONE;

    if (!FIXED_TBANK_PHONE || !FIXED_ALFA_PHONE) {
      throw new Error('Missing required environment variables');
    }

    tbankAutomation = new TBankAutomation({
      username,
      phone: FIXED_TBANK_PHONE,
      password: null,
      encryptionService: null,
      onAuthenticated: null
    });

    smsQueueChecker = setInterval(() => {
      if (!tbankAutomation) return;
      const pendingType = tbankAutomation.getPendingInputType();
      if (pendingType === 'sms') {
        const queuedSMS = smsCodeQueue.get(username);
        if (queuedSMS && Date.now() < queuedSMS.expiresAt) {
          const submitted = tbankAutomation.submitUserInput(queuedSMS.code);
          if (submitted) smsCodeQueue.delete(username);
        }
      }
    }, 500);

    const loginResult = await tbankAutomation.login();
    if (!loginResult.success) {
      throw new Error(`T-Bank login failed: ${loginResult.error}`);
    }

    const transferResult = await tbankAutomation.transferViaSBP(null);
    if (!transferResult.success) {
      throw new Error(`T-Bank SBP transfer failed: ${transferResult.error}`);
    }

    const amount = transferResult.amount;
    clearInterval(smsQueueChecker);

    console.log(`[STEP1] ✅ Completed: ${amount} RUB transferred (browser kept open for STEP2)`);
    return { success: true, amount, browser: tbankAutomation.browser, page: tbankAutomation.page };

  } catch (error) {
    if (smsQueueChecker) clearInterval(smsQueueChecker);
    if (tbankAutomation) await tbankAutomation.close().catch(() => {});
    throw error;
  }
}

// Helper function: Execute evening transfer step 2
async function executeEveningTransferStep2(username, amount, browser = null, page = null) {
  let alfaAutomation = null;
  let alfaSmsQueueChecker = null;

  try {
    console.log(`[STEP2] 🌆 Starting Alfa debit -> saving transfer for ${username}, amount: ${amount}`);

    const FIXED_ALFA_PHONE = process.env.FIXED_ALFA_PHONE;
    const FIXED_ALFA_CARD = process.env.FIXED_ALFA_CARD;
    const FIXED_ALFA_SAVING_ACCOUNT_ID = process.env.FIXED_ALFA_SAVING_ACCOUNT_ID;

    if (!FIXED_ALFA_PHONE || !FIXED_ALFA_CARD || !FIXED_ALFA_SAVING_ACCOUNT_ID) {
      throw new Error('Missing required Alfa environment variables');
    }

    console.log(`[STEP2] ⏳ Waiting 45 seconds for funds to arrive...`);
    await new Promise(resolve => setTimeout(resolve, 45000));

    // Force garbage collection after waiting
    if (global.gc) {
      console.log('[STEP2] 🗑️ Running garbage collection...');
      global.gc();
    }

    if (browser && page) {
      console.log('[STEP2] 🔄 Reusing existing browser from STEP1');
      alfaAutomation = new AlfaAutomation({
        username,
        phone: FIXED_ALFA_PHONE,
        cardNumber: FIXED_ALFA_CARD,
        encryptionService: null,
        browser,
        page
      });
    } else {
      console.log('[STEP2] 🆕 Creating new Alfa-Bank automation instance');
      alfaAutomation = new AlfaAutomation({
        username,
        phone: FIXED_ALFA_PHONE,
        cardNumber: FIXED_ALFA_CARD,
        encryptionService: null
      });
    }

    alfaSmsQueueChecker = setInterval(() => {
      if (!alfaAutomation) return;
      const pendingType = alfaAutomation.getPendingInputType();
      if (pendingType === 'alfa_sms') {
        // Try both login and transfer codes
        const loginKey = `alfa_${username}_login`;
        const transferKey = `alfa_${username}_transfer`;

        let queuedSMS = smsCodeQueue.get(loginKey);
        let usedKey = loginKey;

        if (!queuedSMS) {
          queuedSMS = smsCodeQueue.get(transferKey);
          usedKey = transferKey;
        }

        if (queuedSMS && Date.now() < queuedSMS.expiresAt) {
          console.log(`[ALFA-SMS] 📨 Получен новый SMS-код: ${queuedSMS.code} (type: ${queuedSMS.smsType})`);
          const submitted = alfaAutomation.submitAlfaSMSCode(queuedSMS.code);
          if (submitted) {
            smsCodeQueue.delete(usedKey);
            console.log(`[ALFA-SMS] ✅ SMS-код передан в ожидающий процесс: ${queuedSMS.code}`);
          }
        }
      }
    }, 500);

    const alfaLoginResult = await alfaAutomation.loginAlfa();
    if (!alfaLoginResult.success) {
      throw new Error(`Alfa login failed: ${alfaLoginResult.error}`);
    }

    clearInterval(alfaSmsQueueChecker);

    const alfaTransferResult = await alfaAutomation.transferToAlfaSaving(FIXED_ALFA_SAVING_ACCOUNT_ID, amount);
    if (!alfaTransferResult.success) {
      throw new Error(`Alfa transfer failed: ${alfaTransferResult.error}`);
    }

    await alfaAutomation.close();

    console.log(`[STEP2] ✅ Completed`);
    return { success: true };

  } catch (error) {
    if (alfaSmsQueueChecker) clearInterval(alfaSmsQueueChecker);
    if (alfaAutomation) await alfaAutomation.close().catch(() => {});
    throw error;
  }
}

/**
 * Manual evening transfer (T-Bank -> Alfa-Bank)
 * Wrapper that calls step1 and step2 sequentially
 * POST /api/evening-transfer
 * Body: { username }
 */
app.post('/api/evening-transfer', async (req, res) => {
  try {
    const { username } = req.body;

    if (!username) {
      return res.status(400).json({
        success: false,
        error: 'Missing username'
      });
    }

    console.log(`[API-WRAPPER] 🌆 Evening transfer requested for ${username}`);

    // Execute step 1 (keeps browser open)
    const step1Result = await executeEveningTransferStep1(username);
    const transferredAmount = step1Result.amount;
    const browser = step1Result.browser;
    const page = step1Result.page;

    // Execute step 2 (reuses browser from step1, includes 45s wait + GC)
    await executeEveningTransferStep2(username, transferredAmount, browser, page);

    console.log(`[API-WRAPPER] 🎉 Evening transfer completed successfully!`);

    res.json({
      success: true,
      message: 'Evening transfer completed (via step1 + step2)',
      amount: transferredAmount
    });

  } catch (error) {
    console.error('[API-WRAPPER] ❌ Evening transfer error:', error);

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

/**
 * Evening transfer STEP 1: T-Bank -> Alfa SBP
 * POST /api/evening-transfer-step1
 * Body: { username }
 * Returns: { success, amount }
 */
/**
 * Manual morning transfer (Alfa-Bank -> T-Bank)
 * POST /api/morning-transfer
 * Body: { username, amount } - amount is optional, if not provided will use full balance
 */
app.post('/api/morning-transfer', async (req, res) => {
  let alfaAutomation = null;
  let alfaSmsQueueChecker = null;
  let tbankAutomation = null;
  let tbankSmsQueueChecker = null;

  try {
    const { username, amount } = req.body;

    if (!username) {
      return res.status(400).json({
        success: false,
        error: 'Missing username'
      });
    }

    console.log(`[API] 🌅 Morning transfer STAGE 1 requested for ${username}`);

    // Schedule STAGE 2 immediately (before starting STAGE 1)
    console.log('[API] Scheduling STAGE 2 for +30 minutes via Simple Scheduler...');
    const SimpleScheduler = require('./simple-scheduler.js');
    const scheduler = new SimpleScheduler(username, 'http://localhost:3000');

    // Calculate target time (+30 minutes from now)
    const now = new Date();
    const stage2Time = new Date(now.getTime() + 30 * 60 * 1000);
    const stage2TimeStr = stage2Time.toTimeString().slice(0, 5); // HH:MM format

    scheduler.scheduleOneTimeEvent('morning-stage2', stage2TimeStr);
    console.log(`[API] ✅ STAGE 2 scheduled for ${stage2TimeStr} (30 minutes from now)`);

    // Get fixed credentials from environment
    const FIXED_TBANK_PHONE = process.env.FIXED_TBANK_PHONE;
    const FIXED_ALFA_PHONE = process.env.FIXED_ALFA_PHONE;
    const FIXED_ALFA_CARD = process.env.FIXED_ALFA_CARD;
    const FIXED_ALFA_SAVING_ACCOUNT_ID = process.env.FIXED_ALFA_SAVING_ACCOUNT_ID;

    if (!FIXED_TBANK_PHONE || !FIXED_ALFA_PHONE || !FIXED_ALFA_CARD || !FIXED_ALFA_SAVING_ACCOUNT_ID) {
      throw new Error('Missing required environment variables: FIXED_TBANK_PHONE, FIXED_ALFA_PHONE, FIXED_ALFA_CARD, FIXED_ALFA_SAVING_ACCOUNT_ID');
    }

    console.log(`[API] ✅ Using credentials from environment variables`);
    const alfaSavingAccountId = FIXED_ALFA_SAVING_ACCOUNT_ID;

    // STEP 1: Create Alfa automation and login
    console.log(`[API] Step 1: Creating Alfa-Bank automation instance...`);
    alfaAutomation = new AlfaAutomation({
      username,
      phone: FIXED_ALFA_PHONE,
      cardNumber: FIXED_ALFA_CARD,
      encryptionService: null
    });

    // Poll SMS queue (like evening flow) to auto-submit codes when pending
    alfaSmsQueueChecker = setInterval(() => {
      if (!alfaAutomation) return;
      const pendingType = alfaAutomation.getPendingInputType();
      if (pendingType === 'alfa_sms') {
        // Try both login and transfer codes
        const loginKey = `alfa_${username}_login`;
        const transferKey = `alfa_${username}_transfer`;

        let queuedSMS = smsCodeQueue.get(loginKey);
        let usedKey = loginKey;

        if (!queuedSMS) {
          queuedSMS = smsCodeQueue.get(transferKey);
          usedKey = transferKey;
        }

        if (queuedSMS && Date.now() < queuedSMS.expiresAt) {
          console.log(`[ALFA-SMS] 📨 Получен новый SMS-код: ${queuedSMS.code} (type: ${queuedSMS.smsType})`);
          const submitted = alfaAutomation.submitAlfaSMSCode(queuedSMS.code);
          if (submitted) {
            smsCodeQueue.delete(usedKey);
            console.log(`[ALFA-SMS] ✅ SMS-код передан в ожидающий процесс: ${queuedSMS.code}`);
          }
        }
      }
    }, 500);

    console.log(`[API] Step 2: Logging in to Alfa-Bank...`);
    const alfaLoginResult = await alfaAutomation.loginAlfa();
    if (!alfaLoginResult.success) {
      throw new Error(`Alfa-Bank login failed: ${alfaLoginResult.error}`);
    }
    console.log(`[API] ✅ Alfa-Bank login successful`);

    // STEP 2: Transfer from Alfa saving to Alfa debit account
    const transferAmount = amount ?? null; // null => transfer full balance
    const amountLabel = transferAmount != null ? `${transferAmount}` : 'full balance';
    const alfaDebitAccountName = 'Текущий счёт ··7167';

    console.log(`[API] Step 3: Moving ${amountLabel} from Alfa saving to debit account "${alfaDebitAccountName}"...`);
    const alfaWithdrawResult = await alfaAutomation.transferFromAlfaSaving(
      alfaSavingAccountId,
      alfaDebitAccountName,
      transferAmount
    );

    if (!alfaWithdrawResult.success) {
      throw new Error(`Alfa saving -> debit transfer failed: ${alfaWithdrawResult.error}`);
    }
    console.log('[API] ✅ Alfa saving -> debit transfer successful');
    console.log('[API] ✅ STAGE 1 completed: SAVING→ALFA');

    // Close browser to free memory
    console.log('[API] Closing Alfa browser...');
    await alfaAutomation.close();
    alfaAutomation = null;

    if (alfaSmsQueueChecker) {
      clearInterval(alfaSmsQueueChecker);
      alfaSmsQueueChecker = null;
    }

    if (global.gc) {
      console.log('[API] Running garbage collection after STAGE 1...');
      global.gc();
    }

    console.log(`[API] 🎉 Morning transfer STAGE 1 completed successfully!`);

    res.json({
      success: true,
      message: 'Morning transfer STAGE 1 completed, STAGE 2 already scheduled',
      stage: 1,
      stage2ScheduledFor: stage2TimeStr,
      amount: alfaWithdrawResult.amount || transferAmount
    });

  } catch (error) {
    console.error('[API] ❌ Morning transfer STAGE 1 error:', error);

    if (alfaSmsQueueChecker) {
      clearInterval(alfaSmsQueueChecker);
      alfaSmsQueueChecker = null;
    }

    // Cleanup browser on error
    if (alfaAutomation) {
      try {
        await alfaAutomation.close();
      } catch (e) {
        console.error('[API] Error closing Alfa browser:', e);
      }
      alfaAutomation = null;
    }

    if (global.gc) {
      global.gc();
    }

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// ============================================
// MORNING TRANSFER STAGE 2 ENDPOINT
// ============================================
app.post('/api/morning-transfer-stage2', async (req, res) => {
  let alfaAutomation = null;
  let alfaSmsQueueChecker = null;
  let tbankAutomation = null;
  let tbankSmsQueueChecker = null;

  try {
    const { username, amount } = req.body;

    if (!username) {
      return res.status(400).json({
        success: false,
        error: 'Missing username'
      });
    }

    console.log(`[API] 🌅 Morning transfer STAGE 2 requested for ${username}`);

    // Get fixed credentials from environment
    const FIXED_TBANK_PHONE = process.env.FIXED_TBANK_PHONE;
    const FIXED_ALFA_PHONE = process.env.FIXED_ALFA_PHONE;
    const FIXED_ALFA_CARD = process.env.FIXED_ALFA_CARD;
    const FIXED_ALFA_SAVING_ACCOUNT_ID = process.env.FIXED_ALFA_SAVING_ACCOUNT_ID;

    if (!FIXED_TBANK_PHONE || !FIXED_ALFA_PHONE || !FIXED_ALFA_CARD || !FIXED_ALFA_SAVING_ACCOUNT_ID) {
      throw new Error('Missing required environment variables');
    }

    console.log(`[API] ✅ Using credentials from environment variables`);
    const alfaSavingAccountId = FIXED_ALFA_SAVING_ACCOUNT_ID;

    // STEP 1: Create Alfa automation and login
    console.log(`[API] Step 1: Creating Alfa-Bank automation instance...`);

    // Create new Alfa automation instance for Stage 2
    alfaAutomation = new AlfaAutomation({
      username,
      phone: FIXED_ALFA_PHONE,
      cardNumber: FIXED_ALFA_CARD,
      encryptionService: null
    });

    // Re-create SMS queue checker for Stage 2
    alfaSmsQueueChecker = setInterval(() => {
      if (!alfaAutomation) return;
      const pendingType = alfaAutomation.getPendingInputType();
      if (pendingType === 'alfa_sms') {
        const loginKey = `alfa_${username}_login`;
        const transferKey = `alfa_${username}_transfer`;
        let queuedSMS = smsCodeQueue.get(loginKey);
        let usedKey = loginKey;

        if (!queuedSMS) {
          queuedSMS = smsCodeQueue.get(transferKey);
          usedKey = transferKey;
        }

        if (queuedSMS && Date.now() < queuedSMS.expiresAt) {
          const submitted = alfaAutomation.submitAlfaSMSCode(queuedSMS.code);
          if (submitted) {
            smsCodeQueue.delete(usedKey);
          }
        }
      }
    }, 500);

    console.log('[API] Step 2: Logging in to Alfa-Bank for STAGE 2...');
    const alfaLoginResult2 = await alfaAutomation.loginAlfa();
    if (!alfaLoginResult2.success) {
      throw new Error(`Alfa-Bank login failed for STAGE 2: ${alfaLoginResult2.error}`);
    }
    console.log('[API] ✅ Alfa-Bank login successful for STAGE 2');

    const sbpAmount = amount != null ? amount : null;
    const sbpAmountLabel = sbpAmount != null ? `${sbpAmount}` : 'full balance';

    // STEP 3: Transfer from Alfa debit to T-Bank via SBP
    console.log(`[API] Step 3: Transferring ${sbpAmountLabel} from Alfa debit to T-Bank via SBP...`);

    const transferResult = await alfaAutomation.transferToTBankSBP(
      alfaSavingAccountId,
      FIXED_TBANK_PHONE,
      sbpAmount
    );

    if (!transferResult.success) {
      throw new Error(`Alfa -> T-Bank SBP transfer failed: ${transferResult.error}`);
    }
    console.log(`[API] ✅ Alfa -> T-Bank SBP transfer successful (${transferResult.amount || amount} RUB)`);
    console.log('[API] ✅ STAGE 2 completed: ALFA→TBANK');

    if (alfaSmsQueueChecker) {
      clearInterval(alfaSmsQueueChecker);
      alfaSmsQueueChecker = null;
    }

    if (global.gc) {
      console.log('[API] Running garbage collection before T-Bank login...');
      global.gc();
    }

    // === STAGE 3: TBANK post-transfer steps (19-21) ===
    console.log('[API] === STAGE 3: TBANK post-transfer steps 19-21 ===');
    console.log('[API] Reusing browser, navigating to T-Bank...');

    const reusedBrowser = alfaAutomation.browser;
    const reusedPage = alfaAutomation.page;

    tbankAutomation = new TBankAutomation({
      username,
      phone: FIXED_TBANK_PHONE,
      password: null,
      encryptionService: null,
      onAuthenticated: null,
      existingBrowser: reusedBrowser,
      existingPage: reusedPage
    });

    tbankSmsQueueChecker = setInterval(() => {
      if (!tbankAutomation) return;
      const pendingType = tbankAutomation.getPendingInputType();
      if (pendingType === 'sms') {
        const queuedSMS = smsCodeQueue.get(username);
        if (queuedSMS && Date.now() < queuedSMS.expiresAt) {
          const submitted = tbankAutomation.submitUserInput(queuedSMS.code);
          if (submitted) {
            smsCodeQueue.delete(username);
          }
        }
      }
    }, 500);

    console.log('[API] Step 4: Logging in to T-Bank for Stage 3...');
    const tbankLoginResult = await tbankAutomation.login();
    if (!tbankLoginResult.success) {
      throw new Error(`T-Bank login failed during Stage 3: ${tbankLoginResult.error}`);
    }
    console.log('[API] ✅ T-Bank login successful for Stage 3');

    console.log('[API] Step 5: Running T-Bank post-transfer flow (steps 19-21)...');
    const tbankPostResult = await tbankAutomation.runMorningPostTransferFlow();

    if (!tbankPostResult.success) {
      throw new Error(`T-Bank post-transfer steps failed: ${tbankPostResult.error}`);
    }
    console.log('[API] ✅ T-Bank steps 19-21 completed');

    // Log screenshot base64 if available
    if (tbankPostResult.screenshotBase64) {
      console.log('[API] 📸 === SCREENSHOT BASE64 START [morning-post-transfer-after] ===');
      console.log(tbankPostResult.screenshotBase64);
      console.log('[API] 📸 === SCREENSHOT BASE64 END [morning-post-transfer-after] ===');
    }

    if (tbankSmsQueueChecker) {
      clearInterval(tbankSmsQueueChecker);
      tbankSmsQueueChecker = null;
    }

    await tbankAutomation.close();
    tbankAutomation = null;

    if (alfaAutomation) {
      console.log('[API] Closing shared browser...');
      await alfaAutomation.close();
      alfaAutomation = null;
    }

    if (global.gc) {
      console.log('[API] 🌅 Running garbage collection after morning transfer STAGE 2...');
      global.gc();
    }

    console.log(`[API] 🎉 Morning transfer STAGE 2 completed successfully!`);

    res.json({
      success: true,
      message: 'Morning transfer STAGE 2 completed',
      stage: 2,
      amount: transferResult.amount || amount,
      tbankPostTransfer: tbankPostResult
    });

  } catch (error) {
    console.error('[API] ❌ Morning transfer STAGE 2 error:', error);

    if (alfaSmsQueueChecker) {
      clearInterval(alfaSmsQueueChecker);
      alfaSmsQueueChecker = null;
    }

    // Cleanup browser on error
    if (alfaAutomation) {
      try {
        await alfaAutomation.close();
      } catch (e) {
        console.error('[API] Error closing Alfa browser:', e);
      }
      alfaAutomation = null;
    }

    if (tbankSmsQueueChecker) {
      clearInterval(tbankSmsQueueChecker);
      tbankSmsQueueChecker = null;
    }

    if (tbankAutomation) {
      try {
        await tbankAutomation.close();
      } catch (e) {
        console.error('[API] Error closing T-Bank browser:', e);
      }
      tbankAutomation = null;
    }

    // MEMORY OPTIMIZATION: Run GC after error cleanup
    if (global.gc) {
      console.log('[API] 🧹 Running garbage collection after error cleanup...');
      global.gc();
    }

    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Start server
app.listen(PORT, () => {
  console.log(`🚀 T-Bank Automation Service running on port ${PORT}`);
  console.log(`📅 Session cleanup task scheduled`);

  // Schedule session cleanup every hour
  cron.schedule('0 * * * *', () => {
    console.log('[CRON] Running session cleanup...');
    sessionManager.cleanupExpiredSessions();
  });

  // Schedule SMS queue cleanup every 5 minutes
  cron.schedule('*/5 * * * *', () => {
    const now = Date.now();
    let expiredCount = 0;

    for (const [username, data] of smsCodeQueue.entries()) {
      if (now >= data.expiresAt) {
        console.log(`[CRON] Removing expired SMS code for user ${username}`);
        smsCodeQueue.delete(username);
        expiredCount++;
      }
    }

    if (expiredCount > 0) {
      console.log(`[CRON] Cleaned up ${expiredCount} expired SMS codes`);
    }
  });

  const schedulerUsername = process.env.SCHEDULER_USERNAME;
  const eveningHour = process.env.SCHEDULER_EVENING_HOUR;
  const morningHour = process.env.SCHEDULER_MORNING_HOUR;

  if (schedulerUsername && (eveningHour !== undefined || morningHour !== undefined)) {
    const schedulerBaseUrl = process.env.SCHEDULER_BASE_URL || `http://127.0.0.1:${PORT}`;
    const schedulerTimezone = process.env.SCHEDULER_TIMEZONE;

    simpleScheduler = new SimpleScheduler({
      username: schedulerUsername,
      baseUrl: schedulerBaseUrl,
      eveningHour,
      morningHour,
      timezone: schedulerTimezone
    });

    sessionManager.setSimpleScheduler(simpleScheduler);

    simpleScheduler.start().catch(err => {
      console.error('[SIMPLE-SCHEDULER] Failed to start:', err);
    });
  } else {
    console.log('[SIMPLE-SCHEDULER] Not started: set SCHEDULER_USERNAME and at least one of SCHEDULER_EVENING_HOUR or SCHEDULER_MORNING_HOUR');
    sessionManager.setSimpleScheduler(null);
  }
});

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\nShutting down gracefully...');
  if (simpleScheduler) {
    simpleScheduler.stop();
  }
  sessionManager.stopScheduler();
  await sessionManager.closeAllSessions();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\nShutting down gracefully...');
  if (simpleScheduler) {
    simpleScheduler.stop();
  }
  sessionManager.stopScheduler();
  await sessionManager.closeAllSessions();
  process.exit(0);
});

