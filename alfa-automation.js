import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Use stealth plugin to avoid detection
puppeteer.use(StealthPlugin());

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Environment variable ${name} is required for Alfa automation`);
  }
  return value;
}

/**
 * Alfa-Bank Automation Class
 * Handles login, transfers, and interactions with Alfa-Bank web interface
 */
export class AlfaAutomation {
  constructor({ username, phone, cardNumber, encryptionService, browser = null, page = null }) {
    this.username = username;
    this.phone = phone; // Encrypted
    this.cardNumber = cardNumber; // Encrypted
    this.encryptionService = encryptionService;

    this.browser = browser;
    this.page = page;
    this.authenticated = false;
    this.reusingBrowser = !!(browser && page);

    // SMS code handling
    this.pendingInputType = null;
    this.pendingInputData = null;
    this.alfaSmsCode = null;
    this.alfaSmsCodeResolver = null;
    this.lastAlfaSmsCodeWarning = null;

    // Session stats
    this.sessionStartTime = Date.now();
  }

  /**
   * Random delay to mimic human behavior
   */
  async randomDelay(min = 1000, max = 3000) {
    const delay = Math.floor(Math.random() * (max - min + 1)) + min;
    await new Promise(resolve => setTimeout(resolve, delay));
  }

  /**
   * Simple sleep helper
   * @param {number} ms
   * @returns {Promise<void>}
   */
  async sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Detect whether the Alfa logo is still displayed away from the corner (loading state)
   * @returns {Promise<boolean>}
   */
  async isAlfaLogoOutsideCorner() {
    if (!this.page) {
      return false;
    }

    try {
      return await this.page.evaluate(() => {
        const LOGO_PRIMARY_PATH = 'M23.9607 7.88513';
        const LOGO_BASE_PATH = '39 46H9V40H39V46Z';
        const CORNER_TOP_THRESHOLD = 120;
        const CORNER_LEFT_THRESHOLD = 200;

        const alphaLogos = Array.from(document.querySelectorAll('svg')).filter(svg => {
          const path = svg.querySelector('path');
          if (!path) {
            return false;
          }

          const d = path.getAttribute('d') || '';
          return d.includes(LOGO_PRIMARY_PATH) && d.includes(LOGO_BASE_PATH);
        });

        if (!alphaLogos.length) {
          return false;
        }

        return alphaLogos.some(svg => {
          const rect = svg.getBoundingClientRect();
          if (!rect || (rect.width === 0 && rect.height === 0)) {
            return false;
          }

          const isCornerLogo = rect.top <= CORNER_TOP_THRESHOLD && rect.left <= CORNER_LEFT_THRESHOLD;
          return !isCornerLogo;
        });
      });
    } catch (error) {
      console.log('[ALFA-LOGO] WARN: Unable to determine logo position:', error.message);
      return false;
    }
  }

  /**
   * Wait for selector in all available frames (or specific frame)
   * @param {string} selector
   * @param {Object} options
   * @returns {Promise<{ element: import('puppeteer').ElementHandle, frame: import('puppeteer').Frame }>}
   */
  async waitForSelectorAcrossFrames(selector, options = {}) {
    if (!this.page) {
      throw new Error('Browser page is not initialized');
    }

    const {
      timeout = 30000,
      visible = false,
      hidden = false,
      targetFrame = null,
      pollInterval = 500,
      alternativeSelectors = [],
      textVariants = []
    } = options;

    const startTime = Date.now();
    const maxInterval = Math.max(100, pollInterval);
    let lastError = null;
    let framesLogged = false;

    const expandFrames = (rootFrames) => {
      const result = [];
      const stack = [...(rootFrames || [])];
      while (stack.length > 0) {
        const frame = stack.shift();
        if (!frame || frame.isDetached()) continue;
        result.push(frame);
        if (typeof frame.childFrames === 'function') {
          stack.push(...frame.childFrames());
        }
      }
      return result;
    };

    const normalizedVariants = (Array.isArray(textVariants) ? textVariants : [textVariants])
      .map(v => (typeof v === 'string' ? v.trim().toLowerCase() : ''))
      .filter(Boolean);

    while (true) {
      const elapsed = Date.now() - startTime;
      const remaining = timeout - elapsed;

      if (remaining <= 0) {
        break;
      }

      const frames = targetFrame ? expandFrames([targetFrame]) : expandFrames(this.page.frames());
      const activeFrames = frames.filter(frame => frame && !frame.isDetached());

      if (activeFrames.length === 0) {
        await this.sleep(Math.min(maxInterval, remaining));
        continue;
      }

      if (!framesLogged) {
        const frameUrls = activeFrames.map(frame => {
          try {
            return frame.url();
          } catch (frameError) {
            return '[unknown-url]';
          }
        }).slice(0, 5);
        console.log(`[ALFA-FRAME] scanning "${selector}" across ${activeFrames.length} frame(s); samples: ${frameUrls.join(', ')}`);
        framesLogged = true;
      }

      const waitTimeout = Math.max(100, Math.min(remaining, maxInterval));
      const selectorsToTry = Array.from(
        new Set([selector, ...(Array.isArray(alternativeSelectors) ? alternativeSelectors : [])])
      ).filter(sel => typeof sel === 'string' && sel.trim().length > 0);
      const waiters = [];

      for (const frame of activeFrames) {
        for (const sel of selectorsToTry) {
          waiters.push(
            frame.waitForSelector(sel, {
              timeout: waitTimeout,
              visible,
              hidden
            }).then(element => ({ element, frame, matchedSelector: sel }))
          );
        }
      }

      let result = null;

      try {
        if (waiters.length > 0) {
          result = await Promise.any(waiters);
        }
      } catch (error) {
        if (error instanceof AggregateError) {
          lastError = error.errors && error.errors.length > 0 ? error.errors[0] : error;
        } else {
          throw error;
        }
      }

      if (result && result.element) {
        if (result.matchedSelector && result.matchedSelector !== selector) {
          console.log(`[ALFA-FRAME] Selector fallback matched "${result.matchedSelector}" in frame ${result.frame.url()}`);
        }
        return result;
      }

      if (normalizedVariants.length > 0) {
        for (const frame of activeFrames) {
          try {
            const handle = await frame.evaluateHandle((variants) => {
              const lowerVariants = variants.map(v => v.toLowerCase());
              const candidates = Array.from(document.querySelectorAll('input, textarea'));
              for (const candidate of candidates) {
                const values = [
                  candidate.getAttribute('placeholder'),
                  candidate.getAttribute('aria-label'),
                  candidate.getAttribute('title'),
                  candidate.previousElementSibling?.textContent,
                  candidate.parentElement?.textContent
                ]
                  .filter(Boolean)
                  .map(val => val.trim().toLowerCase());

                if (values.some(val => lowerVariants.some(variant => val.includes(variant)))) {
                  return candidate;
                }
              }
              return null;
            }, normalizedVariants);

            const candidateElement = handle.asElement();
            if (candidateElement) {
              console.log(`[ALFA-FRAME] Fallback matched element by text in frame ${frame.url()}`);
              return { element: candidateElement, frame };
            }
            await handle.dispose();
          } catch (fallbackError) {
            console.log('[ALFA-FRAME] Fallback text search failed:', fallbackError.message);
          }
        }
      }

      await this.sleep(Math.min(maxInterval, remaining));
    }

    if (lastError) {
      throw lastError;
    }

    throw new Error(`Timeout waiting for selector "${selector}" across frames`);
  }

  /**
   * Ожидание появления фрейма, удовлетворяющего predicate
   * @param {(frame: import('puppeteer').Frame) => boolean} predicate
   * @param {Object} options
   */
  async waitForFrame(predicate, options = {}) {
    if (!this.page) {
      throw new Error('Browser page is not initialized');
    }

    const {
      timeout = 30000,
      pollInterval = 500,
      description = 'target frame'
    } = options;

    const startTime = Date.now();
    let iterationCount = 0;

    while (Date.now() - startTime <= timeout) {
      iterationCount++;

      // MEMORY OPTIMIZATION: frames() returns array, limit calls frequency
      const frames = this.page.frames();

      for (const frame of frames) {
        if (!frame || frame.isDetached()) {
          continue;
        }

        let matches = false;
        try {
          matches = Boolean(predicate(frame));
        } catch (predicateError) {
          console.log('[ALFA-FRAME] Predicate error while iterating frames:', predicateError.message);
        }

        if (matches) {
          console.log(`[ALFA-FRAME] Matched frame for ${description}: ${frame.url()} (after ${iterationCount} iterations)`);
          return frame;
        }
      }

      // MEMORY OPTIMIZATION: Force GC every 10 iterations to clear frame references
      if (iterationCount % 10 === 0 && global.gc) {
        global.gc();
      }

      await this.sleep(Math.min(pollInterval, Math.max(100, timeout / 10)));
    }

    throw new Error(`Не удалось найти iframe (${description}) за ${timeout} мс`);
  }

  async waitForSelectorWithRetry(selector, options = {}) {
    const {
      timeout = 30000,
      retries = 3,
      retryDelay = 5000, // Increased to 5 seconds for slow page loads
      visible = false,
      hidden = false,
      waitForLoadingLogo = true,
      logoRetryDelay = 10000,
      maxLogoCycles = null,
      overallTimeout = null,
      targetFrame = null,
      alternativeSelectors = [],
      textVariants = []
    } = options;

    let lastError;
    let logoCycles = 0;
    const overallStart = Date.now();

    while (true) {
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          console.log(`[ALFA-RETRY] Attempt ${attempt}/${retries}: waiting for "${selector}"`);

          const { element, frame: elementFrame } = await this.waitForSelectorAcrossFrames(selector, {
            timeout,
            visible,
            hidden,
            targetFrame,
            alternativeSelectors,
            textVariants
          });

          if (element && elementFrame && typeof element === 'object') {
            try {
              Object.defineProperty(element, '__alfaFrame', {
                value: elementFrame,
                writable: false,
                configurable: true,
                enumerable: false
              });
            } catch {
              element.__alfaFrame = elementFrame;
            }
          }

          console.log(`[ALFA-RETRY] Success: "${selector}" found on attempt ${attempt}`);
          return element;

        } catch (error) {
          lastError = error;
          console.log(`[ALFA-RETRY] Warning: attempt ${attempt}/${retries} failed for "${selector}": ${error.message}`);

          if (attempt < retries) {
            console.log(`[ALFA-RETRY] Waiting ${retryDelay}ms before next attempt...`);
            await this.sleep(retryDelay);
          }
        }
      }

      if (!waitForLoadingLogo) {
        break;
      }

      if (overallTimeout && Date.now() - overallStart > overallTimeout) {
        console.log('[ALFA-RETRY] Stop: overall timeout exceeded while waiting for selector.');
        break;
      }

      const logoBlocking = await this.isAlfaLogoOutsideCorner();
      if (!logoBlocking) {
        console.log('[ALFA-RETRY] Loader logo not detected away from corner; giving up on selector wait.');
        break;
      }

      logoCycles += 1;
      if (maxLogoCycles && logoCycles > maxLogoCycles) {
        console.log(`[ALFA-RETRY] Stop: reached max logo wait cycles (${maxLogoCycles}).`);
        break;
      }

      console.log('[ALFA-RETRY] Loader logo still visible away from corner. Waiting before retrying attempts...');
      await this.sleep(logoRetryDelay);
    }

    // All retries failed
    console.log(`[ALFA-RETRY] Failed: all attempts exhausted for "${selector}"`);
    throw lastError;
  }

  /**
   * Take base64 screenshot for logging
   * @param {string} context - Context description
   */
  async takeScreenshot(context = 'unknown') {
    if (!this.page) return null;

    try {
      const screenshot = await this.page.screenshot({ encoding: 'base64', type: 'png' });
      console.log(`[ALFA] 📸 [${context}] Screenshot captured (base64 length: ${screenshot.length})`);

      // Log base64 only for error screenshots to help debug issues
      if (context.includes('error')) {
        console.log(`[ALFA] 📸 === SCREENSHOT BASE64 START [${context}] ===`);
        console.log(screenshot);
        console.log(`[ALFA] 📸 === SCREENSHOT BASE64 END [${context}] ===`);
      }

      return screenshot;
    } catch (e) {
      console.log(`[ALFA] ⚠️ [${context}] Could not capture screenshot:`, e.message);
      return null;
    }
  }

  /**
   * MEMORY OPTIMIZATION: Clean up CDP sessions to free memory
   */
  async cleanupCDPSessions() {
    if (!this.page) return;

    try {
      const client = await this.page.target().createCDPSession();
      await client.detach();
      console.log('[ALFA-MEMORY] ✅ CDP sessions cleaned');
    } catch (error) {
      // Silently fail - this is just optimization
      console.log('[ALFA-MEMORY] ⚠️ CDP cleanup skipped:', error.message);
    }
  }

  /**
   * Initialize browser
   */
  async initBrowser() {
    console.log('[ALFA-BROWSER] Инициализация браузера...');

    // NOTE: Removed force kill commands before launching browser as they can:
    // 1. Kill ALL Chrome processes on the server (including other sessions/users)
    // 2. Cause server restart on platforms like Render
    // 3. Not needed - each Puppeteer instance manages its own isolated browser process

    const launchOptions = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-software-rasterizer',
        '--disable-extensions',
        '--disable-background-networking',
        '--disable-sync',
        '--metrics-recording-only',
        '--mute-audio',
        '--no-default-browser-check',
        '--disable-hang-monitor',
        '--disable-prompt-on-repost',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-features=TranslateUI,BlinkGenPropertyTrees',
        '--disable-ipc-flooding-protection',
        '--disable-client-side-phishing-detection',
        // MEMORY OPTIMIZATION: Set memory limits for V8 engine
        '--max-old-space-size=256',
        '--js-flags=--max-old-space-size=256'
        // MEMORY OPTIMIZATION: Removed '--single-process' as it causes memory leaks
        // Single-process mode forces all Chromium processes into one, causing poor memory management
      ]
    };

    // IMPORTANT: puppeteer-core requires executablePath
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
      console.log(`[ALFA-BROWSER] Using Chrome from: ${process.env.PUPPETEER_EXECUTABLE_PATH}`);
    } else {
      throw new Error('PUPPETEER_EXECUTABLE_PATH environment variable is required when using puppeteer-core');
    }

    this.browser = await puppeteer.launch(launchOptions);

    this.page = await this.browser.newPage();
    await this.page.setCacheEnabled(true);

    try {
      const networkClient = await this.page.target().createCDPSession();
      await networkClient.send('Network.enable');
      await networkClient.send('Network.setBypassServiceWorker', { bypass: true });
      await networkClient.send('Network.setCacheDisabled', { cacheDisabled: false });
      await networkClient.detach();
    } catch (networkError) {
      console.log('[ALFA-BROWSER] WARN: Unable to adjust network settings:', networkError.message);
    }

    // MEMORY OPTIMIZATION: Disabled page console logging to reduce memory usage
    // The Alfa-Bank page generates thousands of console logs (Federation Runtime, Snowplow, etc.)
    // which consume significant memory. Uncomment only for debugging:
    // this.page.on('console', msg => {
    //   const text = msg.text();
    //   if (text.includes('Found box') || text.includes('matching one of selectors')) {
    //     return;
    //   }
    //   console.log('ALFA PAGE LOG:', text);
    // });

    // MEMORY OPTIMIZATION: Block unnecessary resources to reduce memory usage
    await this.page.setRequestInterception(true);
    this.page.on('request', (request) => {
      const resourceType = request.resourceType();
      const url = request.url();
      const urlLower = url.toLowerCase();

      const blockedUrlFragments = [
        'mc.yandex.ru',
        'google-analytics.com',
        'googletagmanager.com',
        'doubleclick.net',
        'connect.facebook.net',
        'vk.com/rtrg',
        'snowplow',
        'metrics',
        'tracking'
      ];

      // Block images, media, fonts, and analytics to save memory
      if (resourceType === 'image' || resourceType === 'media' || resourceType === 'font') {
        request.abort();
      }
      // Block analytics and tracking scripts (Snowplow, metrics, etc.)
      else if (blockedUrlFragments.some(fragment => urlLower.includes(fragment)) ||
               urlLower.includes('ga.js') || urlLower.includes('gtm.js')) {
        request.abort();
      }
      else {
        request.continue();
      }
    });

    // Set viewport
    await this.page.setViewport({ width: 1366, height: 768 });

    // Set user agent
    await this.page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    console.log('[ALFA-BROWSER] ✅ Браузер инициализирован');
  }

  /**
   * Login to Alfa-Bank
   */
  async loginAlfa() {
    try {
      console.log('[ALFA-LOGIN] Начало входа в Альфа-Банк');

      if (!this.browser) {
        console.log('[ALFA-LOGIN] 🆕 Creating new browser');
        await this.initBrowser();
      } else if (this.reusingBrowser) {
        console.log('[ALFA-LOGIN] 🔄 Reusing existing browser from previous step');
      }

      // Decrypt credentials (if encryptionService is available, otherwise use as-is)
      const phone = this.encryptionService ? this.encryptionService.decrypt(this.phone) : this.phone;
      const cardNumber = this.encryptionService ? this.encryptionService.decrypt(this.cardNumber) : this.cardNumber;

      console.log('[ALFA-LOGIN] Этап 1/9: Переход на web.alfabank.ru');

      const waitStart = Date.now();
      const MAX_TOTAL_WAIT = 240000; // общее ожидание до 4 минут
      const CHECK_INTERVAL = 5000; // проверяем каждые 5 секунд

      const isLoginControlsReady = async () => {
        try {
          return await this.page.evaluate(() => {
            const isVisible = el => !!el && !!(el.offsetWidth || el.offsetHeight || el.getClientRects().length);
            const phoneInput = document.querySelector('input[data-test-id="phoneInput"]');
            const submitButton = document.querySelector('button.phone-auth-browser__submit-button[type="submit"]');
            return isVisible(phoneInput) && isVisible(submitButton);
          });
        } catch {
          return false;
        }
      };

      let navigationSuccessful = false;
      try {
        await this.page.goto('https://web.alfabank.ru/', {
          waitUntil: 'domcontentloaded',
          timeout: 60000
        });
        navigationSuccessful = true;
      } catch (navError) {
        console.log(`[ALFA-LOGIN] ⚠️ Первичная навигация завершилась с ошибкой: ${navError.message}`);
      }

      let loginControlsReady = await isLoginControlsReady();
      let lastProgressLog = 0;

      while (!loginControlsReady && Date.now() - waitStart <= MAX_TOTAL_WAIT) {
        const elapsed = Date.now() - waitStart;

        if (elapsed - lastProgressLog >= 30000) {
          console.log(`[ALFA-LOGIN] ⏳ Ждём форму авторизации уже ${Math.floor(elapsed / 1000)} секунд...`);
          lastProgressLog = elapsed;
        }

        const logoBlocking = await this.isAlfaLogoOutsideCorner();
        if (logoBlocking) {
          console.log('[ALFA-LOGIN] ⌛ Логотип Alfa всё ещё в состоянии загрузки');
        }

        await this.sleep(CHECK_INTERVAL);
        loginControlsReady = await isLoginControlsReady();
      }

      if (!loginControlsReady) {
        throw new Error('Не удалось дождаться формы авторизации (поле и кнопка не появились за 4 минуты)');
      }

      if (navigationSuccessful) {
        console.log('[ALFA-LOGIN] ✅ Страница готова к вводу телефона');
      } else {
        console.log('[ALFA-LOGIN] ✅ Форма авторизации загрузилась после дополнительного ожидания');
        navigationSuccessful = true;
      }

      await this.randomDelay(2000, 4000);

      console.log('[ALFA-LOGIN] Этап 2/9: Ввод номера телефона');
      await this.waitForSelectorWithRetry('input[data-test-id="phoneInput"]', { timeout: 30000, retries: 3 });
      await this.page.type('input[data-test-id="phoneInput"]', phone, { delay: 100 });
      await this.randomDelay(500, 1000);

      console.log('[ALFA-LOGIN] Этап 3/9: Нажатие "Вперёд"');
      const urlBeforeSubmit = this.page.url();
      console.log(`[ALFA-LOGIN] 📍 URL перед нажатием "Вперёд": ${urlBeforeSubmit}`);

      // Wait for navigation to complete after clicking submit
      await Promise.all([
        this.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {
          console.log('[ALFA-LOGIN] ⚠️ Navigation timeout or no navigation occurred');
        }),
        this.page.click('button.phone-auth-browser__submit-button[type="submit"]')
      ]);

      await this.randomDelay(2000, 3000);

      const urlAfterSubmit = this.page.url();
      console.log(`[ALFA-LOGIN] 📍 URL после нажатия "Вперёд": ${urlAfterSubmit}`);

      // Check if card input appears or if we were redirected to finish_signin page
      console.log('[ALFA-LOGIN] Проверяем, какая форма появилась после ввода телефона...');

      let hasCardInput = false;

      try {
        hasCardInput = await this.page.evaluate(() => {
          return Boolean(document.querySelector('input[data-test-id="card-input"]'));
        });
      } catch (evalError) {
        console.log('[ALFA-LOGIN] ⚠️ Не удалось проверить наличие поля карты:', evalError.message);
      }

      console.log(`[ALFA-LOGIN] Форма карты найдена: ${hasCardInput ? 'ДА' : 'НЕТ'}`);

      // If no card input found, try recovery flow (click "Войти" -> "Войти в Альфа-Онлайн")
      if (!hasCardInput) {
        console.log('[ALFA-LOGIN] 🔄 Форма карты не найдена, запускаем recovery flow...');

        try {
          // Wait for "Войти" button
          const loginButtonSelector = 'button.button__component_1cfl7.button__primary_1cfl7';
          await this.page.waitForSelector(loginButtonSelector, { timeout: 10000 });
          console.log('[ALFA-LOGIN] Нажимаем кнопку "Войти"...');
          await this.page.click(loginButtonSelector);
          await this.sleep(3000);

          console.log('[ALFA-LOGIN] Ищем кнопку "Войти в Альфа-Онлайн"...');
          // Click "Войти в Альфа-Онлайн"
          const alfaOnlineLink = await this.page.evaluate(() => {
            const links = Array.from(document.querySelectorAll('a[href="https://web.alfabank.ru/"]'));
            const alfaOnlineLink = links.find(link => {
              const text = link.textContent || '';
              return text.includes('Войти в') && text.includes('Альфа-Онлайн');
            });
            return alfaOnlineLink ? true : false;
          });

          if (alfaOnlineLink) {
            await this.page.evaluate(() => {
              const links = Array.from(document.querySelectorAll('a[href="https://web.alfabank.ru/"]'));
              const alfaOnlineLink = links.find(link => {
                const text = link.textContent || '';
                return text.includes('Войти в') && text.includes('Альфа-Онлайн');
              });
              if (alfaOnlineLink) {
                alfaOnlineLink.click();
              }
            });
            console.log('[ALFA-LOGIN] ✅ Нажали "Войти в Альфа-Онлайн", ожидаем загрузку формы...');
            await this.sleep(5000);

            // Wait for phone input again
            console.log('[ALFA-LOGIN] Ожидаем повторное появление формы телефона...');
            await this.waitForSelectorWithRetry('input[data-test-id="phoneInput"]', { timeout: 30000, retries: 3 });

            // Re-enter phone
            console.log('[ALFA-LOGIN] Повторный ввод номера телефона...');
            await this.page.type('input[data-test-id="phoneInput"]', phone, { delay: 100 });
            await this.randomDelay(500, 1000);

            console.log('[ALFA-LOGIN] Повторное нажатие "Вперёд"...');
            await Promise.all([
              this.page.waitForNavigation({ waitUntil: 'domcontentloaded', timeout: 30000 }).catch(() => {}),
              this.page.click('button.phone-auth-browser__submit-button[type="submit"]')
            ]);
            await this.randomDelay(2000, 3000);

            // Check for card input again
            hasCardInput = await this.page.evaluate(() => {
              return Boolean(document.querySelector('input[data-test-id="card-input"]'));
            });
            console.log(`[ALFA-LOGIN] После повторного входа - форма карты найдена: ${hasCardInput ? 'ДА' : 'НЕТ'}`);
          } else {
            throw new Error('Не удалось найти ссылку "Войти в Альфа-Онлайн"');
          }
        } catch (redirectError) {
          console.error('[ALFA-LOGIN] ❌ Ошибка при обработке редиректа:', redirectError.message);
          await this.takeScreenshot('alfa-login-redirect-error');
          throw redirectError;
        }
      }

      // Now proceed with card input
      if (hasCardInput) {
        console.log('[ALFA-LOGIN] Этап 4/9: Ввод номера карты');
        await this.waitForSelectorWithRetry('input[data-test-id="card-input"]', { timeout: 30000, retries: 3 });
        await this.page.type('input[data-test-id="card-input"]', cardNumber, { delay: 100 });
        await this.randomDelay(500, 1000);

        console.log('[ALFA-LOGIN] Этап 5/9: Нажатие "Продолжить"');
        await this.page.click('button[data-test-id="card-continue-button"]');
        await this.randomDelay(2000, 3000);
      } else {
        throw new Error('Не удалось найти поле ввода карты после всех попыток');
      }

      console.log('[ALFA-LOGIN] Этап 6/9: Ожидание SMS-кода');
      this.pendingInputType = 'alfa_sms';
      this.pendingInputData = {
        message: 'Ожидание SMS-кода от Альфа-Банка'
      };

      await this.waitForAlfaSMSCode(120000, 3); // 2 minutes timeout per attempt, max 3 retries

      console.log('[ALFA-LOGIN] Этап 7/9: Ввод SMS-кода');
      console.log(`[ALFA-LOGIN] 📝 SMS-код для ввода: "${this.alfaSmsCode}" (длина: ${this.alfaSmsCode ? this.alfaSmsCode.length : 0})`);
      await this.waitForSelectorWithRetry('input.code-input__input_71x65', { timeout: 30000, retries: 3 });

      const urlBeforeSmsEntry = this.page.url();
      console.log(`[ALFA-LOGIN] 📍 URL перед вводом SMS-кода: ${urlBeforeSmsEntry}`);

      await this.enterAlfaSMSCode(this.alfaSmsCode);
      await this.randomDelay(2000, 4000);

      console.log('[ALFA-LOGIN] Этап 8/9: Проверка успешной авторизации');
      const postLoginTimeout = 60000; // Increased to 60 seconds for slow page loads
      const pollInterval = 1000;
      const postLoginStart = Date.now();
      let dashboardReached = false;
      let trustPromptVisible = false;

      while (Date.now() - postLoginStart < postLoginTimeout) {
        let hasTrustPrompt = false;
        try {
          hasTrustPrompt = await this.page.evaluate(() => {
            const targetText = 'Доверять этому устройству?';
            if (!document.body) {
              return false;
            }

            // MEMORY OPTIMIZED: use TreeWalker instead of querySelectorAll('body *')
            const walker = document.createTreeWalker(
              document.body,
              NodeFilter.SHOW_ELEMENT
            );

            let element;
            while (element = walker.nextNode()) {
              if (!element.textContent) {
                continue;
              }

              const normalizedText = element.textContent
                .replace(/\u00A0/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();

              if (!normalizedText.includes(targetText)) {
                continue;
              }

              const style = window.getComputedStyle(element);
              if (!style) {
                continue;
              }

              if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
                continue;
              }

              const rect = element.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                return true;
              }
            }

            return false;
          });
        } catch (evaluateError) {
          const errorMessage = evaluateError?.message || '';
          if (
            errorMessage.includes('Execution context was destroyed') ||
            errorMessage.includes('Cannot find context') ||
            errorMessage.includes('Target closed')
          ) {
            await new Promise(resolve => setTimeout(resolve, 250));
            continue;
          }
          throw evaluateError;
        }

        if (hasTrustPrompt) {
          trustPromptVisible = true;
          break;
        }

        const currentUrl = this.page.url();
        if (currentUrl.includes('web.alfabank.ru/dashboard')) {
          dashboardReached = true;
          break;
        }

        await new Promise(resolve => setTimeout(resolve, pollInterval));
      }

      if (!dashboardReached && !trustPromptVisible) {
        const urlAfterTimeout = this.page.url();
        console.log(`[ALFA-LOGIN] 📍 URL до ввода SMS: ${urlBeforeSmsEntry}`);
        console.log(`[ALFA-LOGIN] 📍 URL после таймаута: ${urlAfterTimeout}`);

        // If URL hasn't changed, try to request code again
        if (urlBeforeSmsEntry === urlAfterTimeout) {
          console.log('[ALFA-LOGIN] ⚠️ URL не изменился - пробуем запросить код повторно (до 3 попыток)');

          let resendSuccess = false;
          for (let resendAttempt = 1; resendAttempt <= 3; resendAttempt++) {
            console.log(`[ALFA-LOGIN] 🔄 Попытка запроса кода ${resendAttempt}/3...`);

            try {
              const resendClicked = await this.page.evaluate(() => {
                // Try specific selector first
                let resendButton = document.querySelector('button.code-input__resend_SLXa8');

                if (!resendButton) {
                  // Try finding by text - search for all variants
                  const buttons = Array.from(document.querySelectorAll('button'));
                  resendButton = buttons.find(btn =>
                    btn.textContent.includes('Запросить код повторно') ||
                    btn.textContent.includes('Отправить код повторно') ||
                    btn.textContent.includes('Запросить код')
                  );
                }

                if (resendButton) {
                  resendButton.scrollIntoView({ behavior: 'instant', block: 'center' });
                  resendButton.click();
                  return true;
                }

                return false;
              });

              if (resendClicked) {
                console.log('[ALFA-LOGIN] ✅ Кнопка "Запросить код повторно" нажата');
                resendSuccess = true;

                // Wait for new SMS code
                await new Promise(resolve => setTimeout(resolve, 3000));

                // Clear pending input to request new code
                this.alfaSmsCode = null;
                this.pendingInputType = 'alfa_sms';
                this.pendingInputData = {
                  message: 'Ожидание нового SMS-кода от Альфа-Банка'
                };

                console.log('[ALFA-LOGIN] ⏳ Ожидание нового SMS-кода...');
                await this.waitForAlfaSMSCode(120000, 1); // 2 minutes timeout, single attempt

                console.log('[ALFA-LOGIN] 📝 Очистка старых значений в полях ввода...');
                // Clear existing input fields
                const inputs = await this.page.$$('input.code-input__input_71x65');
                for (let i = 0; i < inputs.length; i++) {
                  await inputs[i].click();
                  await this.randomDelay(50, 100);
                  await inputs[i].focus();
                  await this.randomDelay(50, 100);
                  // Select all and delete
                  await this.page.keyboard.down('Control');
                  await this.page.keyboard.press('KeyA');
                  await this.page.keyboard.up('Control');
                  await this.page.keyboard.press('Backspace');
                  await this.randomDelay(100, 200);
                }

                console.log('[ALFA-LOGIN] 📝 Ввод нового SMS-кода: ' + this.alfaSmsCode);
                await this.enterAlfaSMSCode(this.alfaSmsCode);
                await this.randomDelay(2000, 4000);

                // Re-check authorization
                console.log('[ALFA-LOGIN] 🔄 Повторная проверка авторизации...');
                const recheckStart = Date.now();
                const recheckTimeout = 60000;

                while (Date.now() - recheckStart < recheckTimeout) {
                  const currentUrl = this.page.url();
                  if (currentUrl.includes('web.alfabank.ru/dashboard')) {
                    dashboardReached = true;
                    console.log('[ALFA-LOGIN] ✅ Авторизация успешна после повторного ввода кода');
                    break;
                  }

                  const hasTrustPrompt = await this.page.evaluate(() => {
                    const targetText = 'Доверять этому устройству?';
                    if (!document.body) return false;
                    const elements = Array.from(document.querySelectorAll('body *'));
                    return elements.some(element => {
                      if (!element.textContent) return false;
                      const normalizedText = element.textContent.replace(/\u00A0/g, ' ').replace(/\s+/g, ' ').trim();
                      if (!normalizedText.includes(targetText)) return false;
                      const style = window.getComputedStyle(element);
                      if (!style) return false;
                      if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) return false;
                      const rect = element.getBoundingClientRect();
                      return rect.width > 0 && rect.height > 0;
                    });
                  }).catch(() => false);

                  if (hasTrustPrompt) {
                    trustPromptVisible = true;
                    console.log('[ALFA-LOGIN] ✅ Диалог доверия появился после повторного ввода кода');
                    break;
                  }

                  await new Promise(resolve => setTimeout(resolve, 1000));
                }

                if (dashboardReached || trustPromptVisible) {
                  break; // Exit resend loop
                }

              } else {
                console.log(`[ALFA-LOGIN] ⚠️ Попытка ${resendAttempt}/3: Кнопка "Запросить код повторно" не найдена`);
                if (resendAttempt < 3) {
                  await new Promise(resolve => setTimeout(resolve, 2000));
                }
              }

            } catch (resendError) {
              console.log(`[ALFA-LOGIN] ⚠️ Ошибка при попытке ${resendAttempt}/3:`, resendError.message);
              if (resendAttempt < 3) {
                await new Promise(resolve => setTimeout(resolve, 2000));
              }
            }
          }

          if (!resendSuccess || (!dashboardReached && !trustPromptVisible)) {
            throw new Error('Не удалось подтвердить успешную авторизацию: ни дашборд, ни диалог доверия не появились в течение 60 секунд (после 3 попыток повторного запроса кода)');
          }
        } else {
          throw new Error('Не удалось подтвердить успешную авторизацию: ни дашборд, ни диалог доверия не появились в течение 60 секунд');
        }
      }

      console.log('[ALFA-LOGIN] Этап 9/9: Проверка диалога "Доверять устройству?" (ожидание до 60 секунд)');

      // Wait up to 60 seconds for trust dialog to appear (even if dashboard already reached)
      const trustDialogTimeout = 60000;
      const trustDialogCheckInterval = 1000;
      const trustDialogCheckStart = Date.now();
      let trustDialogFound = false;

      while (Date.now() - trustDialogCheckStart < trustDialogTimeout) {
        let hasTrustPrompt = false;
        try {
          hasTrustPrompt = await this.page.evaluate(() => {
            const targetText = 'Доверять этому устройству?';
            if (!document.body) {
              return false;
            }

            // MEMORY OPTIMIZED: use TreeWalker instead of querySelectorAll('body *')
            const walker = document.createTreeWalker(
              document.body,
              NodeFilter.SHOW_ELEMENT
            );

            let element;
            while (element = walker.nextNode()) {
              if (!element.textContent) {
                continue;
              }

              const normalizedText = element.textContent
                .replace(/\u00A0/g, ' ')
                .replace(/\s+/g, ' ')
                .trim();

              if (!normalizedText.includes(targetText)) {
                continue;
              }

              const style = window.getComputedStyle(element);
              if (!style) {
                continue;
              }

              if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
                continue;
              }

              const rect = element.getBoundingClientRect();
              if (rect.width > 0 && rect.height > 0) {
                return true;
              }
            }

            return false;
          });
        } catch (evaluateError) {
          const errorMessage = evaluateError?.message || '';
          if (
            errorMessage.includes('Execution context was destroyed') ||
            errorMessage.includes('Cannot find context') ||
            errorMessage.includes('Target closed')
          ) {
            await new Promise(resolve => setTimeout(resolve, 250));
            continue;
          }
          // If evaluation error is not context-related, just continue checking
          await new Promise(resolve => setTimeout(resolve, trustDialogCheckInterval));
          continue;
        }

        if (hasTrustPrompt) {
          trustDialogFound = true;
          console.log('[ALFA-LOGIN] Найден диалог "Доверять этому устройству?", нажимаем "Не доверять"');

          const trustCancelButton = await this.waitForSelectorWithRetry('button[data-test-id="trust-device-page-cancel-btn"]', {
            timeout: 5000,
            retries: 3
          }).catch(() => null);

          if (trustCancelButton) {
            await trustCancelButton.click();
            await this.randomDelay(1000, 2000);
            console.log('[ALFA-LOGIN] ✅ Кнопка "Не доверять" успешно нажата');
          } else {
            console.log('[ALFA-LOGIN] ⚠️ Кнопка "Не доверять" не найдена, продолжаем без клика');
          }

          // Wait for navigation to dashboard after clicking
          try {
            await this.page.waitForFunction(
              () => window.location.href.includes('web.alfabank.ru/dashboard'),
              { timeout: 20000 }
            );
            dashboardReached = true;
          } catch (navError) {
            console.log(`[ALFA-LOGIN] ⚠️ Не удалось дождаться перехода на дашборд после отказа в доверии: ${navError.message}`);
          }

          break; // Exit loop after handling trust dialog
        }

        await new Promise(resolve => setTimeout(resolve, trustDialogCheckInterval));
      }

      if (!trustDialogFound) {
        console.log('[ALFA-LOGIN] Диалог доверия не появился в течение 40 секунд, продолжаем');
      }

      if (!dashboardReached) {
        throw new Error('Авторизация не завершилась переходом на дашборд');
      }

      this.authenticated = true;
      this.pendingInputType = null;
      this.pendingInputData = null;

      // Clear SMS code from memory after successful login
      console.log('[ALFA-LOGIN] 🧹 Очистка SMS-кода из памяти после успешной авторизации');
      this.alfaSmsCode = null;

      console.log('[ALFA-LOGIN] ✅ Логин успешен');

      return { success: true };

    } catch (error) {
      console.error('[ALFA-LOGIN] ❌ Ошибка:', error.message);

      // Take error screenshot
      await this.takeScreenshot('alfa-login-error');

      this.pendingInputType = null;
      this.pendingInputData = null;

      // Clear SMS code from memory on error to avoid reusing old codes
      console.log('[ALFA-LOGIN] 🧹 Очистка SMS-кода из памяти после ошибки');
      this.alfaSmsCode = null;

      throw error;
    }
  }

  /**
   * Wait for Alfa SMS code with retry logic
   * @param {number} timeout - Timeout in milliseconds for each attempt
   * @param {number} maxRetries - Maximum number of retry attempts
   */
  async waitForAlfaSMSCode(timeout = 120000, maxRetries = 3) {
    let attempt = 0;

    while (attempt < maxRetries) {
      attempt++;
      console.log(`[ALFA-SMS] 📱 Попытка ${attempt}/${maxRetries}: Ожидание SMS-кода...`);

      // Clear any old SMS code from memory before waiting for a new one
      console.log('[ALFA-SMS] 🧹 Очистка старого SMS-кода перед ожиданием нового');
      this.alfaSmsCode = null;

      try {
        await new Promise((resolve, reject) => {
          this.alfaSmsCodeResolver = resolve;

          const timeoutId = setTimeout(() => {
            this.alfaSmsCodeResolver = null;
            reject(new Error('Alfa SMS code timeout'));
          }, timeout);

          // Store timeout ID to clear it when code arrives
          this.alfaSmsCodeTimeout = timeoutId;
        });

        // If we got here, the code was successfully received
        console.log('[ALFA-SMS] ✅ SMS-код получен успешно');
        return;

      } catch (error) {
        console.log(`[ALFA-SMS] ⏱️ Таймаут ожидания SMS-кода (попытка ${attempt}/${maxRetries})`);

        if (attempt >= maxRetries) {
          console.log('[ALFA-SMS] ❌ Превышено максимальное количество попыток');

          // Try to find and click resend button before throwing final error
          console.log('[ALFA-SMS] 🔄 Последняя попытка запросить код перед ошибкой...');

          try {
            const resendClicked = await this.page.evaluate(() => {
              // Try specific selector first (from HTML example)
              let resendButton = document.querySelector('button.confirmation__getCodeButton_o4w4f');

              // Fallback to finding by text - search for all variants
              if (!resendButton) {
                const buttons = Array.from(document.querySelectorAll('button'));
                resendButton = buttons.find(btn =>
                  btn.textContent.includes('Запросить код повторно') ||
                  btn.textContent.includes('Отправить код повторно') ||
                  btn.textContent.includes('Запросить код')
                );
              }

              if (resendButton) {
                resendButton.scrollIntoView({ behavior: 'instant', block: 'center' });
                resendButton.click();
                return true;
              }
              return false;
            });

            if (resendClicked) {
              console.log('[ALFA-SMS] ✅ Кнопка запроса кода нажата перед финальной ошибкой');
              await new Promise(resolve => setTimeout(resolve, 3000));

              // Give one more chance to receive the code
              console.log('[ALFA-SMS] ⏳ Даём ещё одну попытку получить код после нажатия кнопки...');
              try {
                await new Promise((resolve, reject) => {
                  this.alfaSmsCodeResolver = resolve;
                  const timeoutId = setTimeout(() => {
                    this.alfaSmsCodeResolver = null;
                    reject(new Error('Final SMS code timeout'));
                  }, 120000); // 2 minutes
                  this.alfaSmsCodeTimeout = timeoutId;
                });
                console.log('[ALFA-SMS] ✅ SMS-код получен после финального запроса!');
                return; // Successfully received code, exit function
              } catch (finalError) {
                console.log('[ALFA-SMS] ❌ SMS-код не получен даже после финального запроса');
              }
            } else {
              console.log('[ALFA-SMS] ⚠️ Кнопка запроса кода не найдена перед финальной ошибкой');
            }
          } catch (clickError) {
            console.log('[ALFA-SMS] ⚠️ Ошибка при финальной попытке запроса кода:', clickError.message);
          }

          throw new Error('Alfa SMS code timeout after all retries');
        }

        // Try to find and click resend button
        console.log('[ALFA-SMS] 🔄 Попытка запросить код повторно...');

        try {
          const resendClicked = await this.page.evaluate(() => {
            // Try specific selector first (from HTML example)
            let resendButton = document.querySelector('button.confirmation__getCodeButton_o4w4f');

            // Fallback to finding by text - search for all variants
            if (!resendButton) {
              const buttons = Array.from(document.querySelectorAll('button'));
              resendButton = buttons.find(btn =>
                btn.textContent.includes('Запросить код повторно') ||
                btn.textContent.includes('Отправить код повторно') ||
                btn.textContent.includes('Запросить код')
              );
            }

            if (resendButton) {
              resendButton.scrollIntoView({ behavior: 'instant', block: 'center' });
              resendButton.click();
              return true;
            }
            return false;
          });

          if (resendClicked) {
            console.log('[ALFA-SMS] ✅ Кнопка запроса кода нажата');
            await new Promise(resolve => setTimeout(resolve, 2000)); // Wait for request to process
          } else {
            console.log('[ALFA-SMS] ⚠️ Кнопка запроса кода не найдена');
            // Continue to next attempt anyway
          }
        } catch (clickError) {
          console.log('[ALFA-SMS] ⚠️ Ошибка при попытке нажать кнопку повторного запроса:', clickError.message);
        }
      }
    }
  }

  /**
   * Submit Alfa SMS code (called from external API)
   */
  submitAlfaSMSCode(code) {
    const isNewCode = this.alfaSmsCode !== code;

    // Skip processing if this is not a new code (prevent spam from 500ms interval checker)
    if (!isNewCode) {
      return false;
    }

    console.log(`[ALFA-SMS] 📨 Получен новый SMS-код: ${code}`);
    this.alfaSmsCode = code;

    if (this.alfaSmsCodeResolver) {
      console.log(`[ALFA-SMS] ✅ SMS-код передан в ожидающий процесс: ${code}`);
      clearTimeout(this.alfaSmsCodeTimeout);
      this.alfaSmsCodeResolver(code);
      this.alfaSmsCodeResolver = null;
      return true;
    } else {
      console.log(`[ALFA-SMS] ⚠️ SMS-код получен, но никто его не ждёт (будет сохранён в памяти): ${code}`);
      return false;
    }
  }

  /**
   * Enter Alfa SMS code into 4 separate inputs
   */
  async enterAlfaSMSCode(code) {
    const inputs = await this.page.$$('input.code-input__input_71x65');

    if (inputs.length < 4) {
      throw new Error('Не найдено 4 поля для ввода SMS-кода');
    }

    console.log(`[ALFA-LOGIN] 📝 Ввод SMS-кода: "${code}" (длина: ${code.length})`);

    for (let i = 0; i < 4 && i < code.length; i++) {
      const digit = code[i];
      console.log(`[ALFA-LOGIN] ⌨️  Ввод цифры ${i + 1}/4: "${digit}"`);

      // Click to focus
      await inputs[i].click();
      await this.randomDelay(100, 200);

      // Focus explicitly
      await inputs[i].focus();
      await this.randomDelay(100, 200);

      // Type with delay
      await inputs[i].type(digit, { delay: 100 });
      await this.randomDelay(300, 500);

      console.log(`[ALFA-LOGIN] ✅ Цифра ${i + 1}/4 введена и обработана`);
    }

    console.log('[ALFA-LOGIN] ✅ SMS-код полностью введён');
  }

  /**
   * Get Alfa saving accounts
   */
  async getAlfaSavingAccounts() {
    try {
      console.log('[ALFA-ACCOUNTS] Получение накопительных счетов');

      if (!this.authenticated) {
        throw new Error('Не авторизован в Альфа-Банке');
      }

      // Navigate to dashboard if not already there
      const currentUrl = this.page.url();
      if (!currentUrl.includes('/dashboard')) {
        await this.page.goto('https://web.alfabank.ru/dashboard', {
          waitUntil: 'networkidle2',
          timeout: 60000
        });
        await this.randomDelay(2000, 3000);
      }

      // Find saving accounts by data-test-id pattern
      const savingAccounts = [];

      const accountElements = await this.page.$$('section[data-test-id^="product-view-component-"]');

      for (const element of accountElements) {
        try {
          // Check if it's a saving account
          const titleElement = await element.$('p.SaH2t');
          if (!titleElement) continue;

          const title = await this.page.evaluate(el => el.textContent, titleElement);

          // Накопительный счёт contains "Альфа-Счёт" or "Накопительный"
          if (title.includes('Альфа-Счёт') || title.includes('Накопительный')) {
            const testId = await this.page.evaluate(el => el.getAttribute('data-test-id'), element);
            const accountId = testId.replace('product-view-component-', '');

            // Get balance
            const balanceElement = await element.$('span[data-test-id="product-view-amount"]');
            let balance = '0';
            if (balanceElement) {
              balance = await this.page.evaluate(el => el.textContent, balanceElement);
            }

            savingAccounts.push({
              id: accountId,
              name: title.trim(),
              balance: balance.trim()
            });
          }
        } catch (err) {
          console.error('[ALFA-ACCOUNTS] Ошибка парсинга счёта:', err.message);
        }
      }

      console.log(`[ALFA-ACCOUNTS] ✅ Найдено ${savingAccounts.length} накопительных счетов`);
      return savingAccounts;

    } catch (error) {
      console.error('[ALFA-ACCOUNTS] ❌ Ошибка:', error.message);
      throw error;
    }
  }

  /**
   * Ensure dashboard is visible by checking key indicators and handling the trust dialog
   * @param {string} prefix - Log prefix used to identify caller context
   * @returns {{ready: boolean, state: object, missing: string[]}} Dashboard readiness report
   */
  async ensureDashboardReady(prefix = '[ALFA]') {
    const log = message => console.log(`${prefix} ${message}`);
    let finalState = null;

    try {
      await this.page.waitForFunction(
        () => window.location.href.includes('web.alfabank.ru/dashboard'),
        { timeout: 3000 }
      );
    } catch {
      await this.page.goto('https://web.alfabank.ru/dashboard', {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      });
    }

    // Give page time to render dashboard widgets after navigation/load
    await this.sleep(6000);

    const dashboardTimeout = 15000;
    const checkInterval = 1000;
    const start = Date.now();

    while (Date.now() - start < dashboardTimeout) {
      const dashboardState = await this.page.evaluate(() => {
        const normalize = text => (text || '').replace(/\s+/g, ' ').trim();

        const hasProductsHeader = Array.from(document.querySelectorAll('h3')).some(
          header => normalize(header.textContent) === 'Мои продукты'
        );

        const hasSettingsButton = Boolean(
          document.querySelector('button[data-test-id="hidden-products-settings-button"]')
        );

        const hasQuickActionsHeader = Boolean(
          document.querySelector('h3[data-test-id="quick-actions-header-my-payments"]')
        );

        const trustButton = document.querySelector('button[data-test-id="trust-device-page-cancel-btn"]');
        let trustPromptVisible = false;

        if (trustButton) {
          const style = window.getComputedStyle(trustButton);
          if (
            style &&
            style.display !== 'none' &&
            style.visibility !== 'hidden' &&
            Number(style.opacity) !== 0
          ) {
            const rect = trustButton.getBoundingClientRect();
            trustPromptVisible = rect.width > 0 && rect.height > 0;
          }
        }

        return {
          hasProductsHeader,
          hasSettingsButton,
          hasQuickActionsHeader,
          trustPromptVisible
        };
      });

      finalState = dashboardState;

      if (
        dashboardState.hasProductsHeader ||
        dashboardState.hasSettingsButton ||
        dashboardState.hasQuickActionsHeader
      ) {
        const indicators = [];
        if (dashboardState.hasProductsHeader) indicators.push('заголовок "Мои продукты"');
        if (dashboardState.hasSettingsButton) indicators.push('кнопка настройки скрытия продуктов');
        if (dashboardState.hasQuickActionsHeader) indicators.push('секция "Мои платежи"');
        log(`Подтверждены элементы дашборда: ${indicators.join(', ')}`);
        return { ready: true, state: dashboardState, missing: [] };
      }

      if (dashboardState.trustPromptVisible) {
        log('Обнаружен диалог "Доверять этому устройству?", нажимаем "Не доверять"');
        try {
          await this.page.click('button[data-test-id="trust-device-page-cancel-btn"]');
          await this.sleep(10000);
        } catch (err) {
          log(`⚠️ Не удалось нажать "Не доверять": ${err.message}`);
        }
      }

      await this.sleep(checkInterval);
    }

    if (finalState) {
      log(`Финальное состояние проверок дашборда: ${JSON.stringify(finalState)}`);
    } else {
      log('Финальное состояние проверок дашборда: не определено');
    }

    const missing = [];
    if (!finalState?.hasProductsHeader) missing.push('заголовок "Мои продукты"');
    if (!finalState?.hasSettingsButton) missing.push('кнопка настройки скрытия продуктов');
    if (!finalState?.hasQuickActionsHeader) missing.push('секция "Мои платежи"');
    if (finalState?.trustPromptVisible) missing.push('диалог "Доверять этому устройству?" остается открыт');

    return {
      ready: false,
      state: finalState || {},
      missing
    };
  }

  /**
   * Parse localized money strings (e.g., "16 223,70 ₽") to float
   * @param {string} value
   * @returns {number}
   */
  parseMoneyString(value) {
    if (typeof value !== 'string') {
      return 0;
    }

    const normalized = value
      .replace(/\u00A0/g, ' ')
      .replace(/[^\d,.,-]/g, '')
      .replace(/\s+/g, '')
      .replace(',', '.');

    const parsed = parseFloat(normalized);
    return Number.isFinite(parsed) ? parsed : 0;
  }

  /**
   * Transfer to Alfa saving account
   * (from Alfa debit account to Alfa saving account)
   */
  async transferToAlfaSaving(savingAccountId, amount) {
    try {
      console.log(`[ALFA→SAVING] Начало перевода ${amount}₽ на накопительный счёт`);

      if (!this.authenticated) {
        throw new Error('Не авторизован в Альфа-Банке');
      }

      const waitBetweenSteps = async () => {
        await this.sleep(15000);
      };

      console.log(`[ALFA→SAVING] Источник средств: счёт ${savingAccountId}`);

      console.log('[ALFA→SAVING] Этап 1/5: Переход на страницу перевода между счетами');
      const requiredSavingAccountId = requireEnv('ALFA_REQUIRED_SAVING_ACCOUNT_ID');
      if (savingAccountId && savingAccountId !== requiredSavingAccountId) {
        console.log(`[ALFA→SAVING] ⚠️ Используем предписанный счёт ${requiredSavingAccountId} вместо переданного ${savingAccountId}`);
      }
      const transferUrl = `https://web.alfabank.ru/transfers/account-to-account?destinationAccount=${requiredSavingAccountId}&type=FROM_ALFA_ACCOUNT`;
      await this.page.goto(transferUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await waitBetweenSteps();

      console.log('[ALFA→SAVING] Этап 2/5: Выбор счёта списания "Текущий счёт ··7167"');
      const accountOptionSelector = 'div[data-test-id="src-account-option"]';
      const optionsListSelector = 'div[data-test-id="src-account-options-list"]';

      const ensureAccountDropdownOpen = async () => {
        const optionVisible = await this.page.$(accountOptionSelector);
        if (optionVisible) return;

        const triggerSelectors = [
          '[data-test-id="src-account-select"]',
          '[data-test-id="src-account-selector"]',
          '[data-test-id="src-account-dropdown"]',
          '[data-test-id="src-account"] button',
          '[aria-haspopup="listbox"][role="combobox"]',
          'button[aria-haspopup="listbox"]',
          '[data-test-id="src-account-options-trigger"]'
        ];

        const clickTrigger = async selector => {
          const clicked = await this.page.evaluate(sel => {
            const el = document.querySelector(sel);
            if (!el) return false;
            if (typeof el.click === 'function') {
              el.click();
              return true;
            }
            if (el instanceof SVGElement) {
              el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
              return true;
            }
            return false;
          }, selector);

          if (!clicked) {
            return false;
          }

          return true;
        };

        for (const selector of triggerSelectors) {
          const opened = await clickTrigger(selector);
          if (opened) {
            await this.sleep(500);
            const check = await this.page.$(accountOptionSelector);
            if (check) return;
          }
        }

        const fallbackTriggered = await this.page.evaluate(() => {
          const candidates = Array.from(
            document.querySelectorAll('[aria-haspopup="listbox"], [data-test-id]')
          );

          for (const candidate of candidates) {
            if (
              !(candidate instanceof HTMLElement) &&
              !(candidate instanceof SVGElement)
            ) {
              continue;
            }

            const dataset = candidate.dataset || {};
            const isSourceTrigger = Object.keys(dataset).some(key =>
              key.toLowerCase().includes('src') && key.toLowerCase().includes('account')
            );

            if (isSourceTrigger || candidate.getAttribute('role') === 'combobox') {
              if (typeof candidate.click === 'function') {
                candidate.click();
              } else {
                candidate.dispatchEvent(new MouseEvent('click', { bubbles: true }));
              }
              return true;
            }
          }
          return false;
        });

        if (fallbackTriggered) {
          await this.sleep(500);
        }
      };

      // Use retry logic for dropdown opening
      let dropdownOpened = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          console.log(`[ALFA→SAVING] Попытка ${attempt}/3: Открытие выпадающего списка счетов`);
          await ensureAccountDropdownOpen();
          await this.waitForSelectorWithRetry(`${optionsListSelector}, ${accountOptionSelector}`, { timeout: 15000, retries: 1 });
          await ensureAccountDropdownOpen();
          await this.waitForSelectorWithRetry(accountOptionSelector, { timeout: 15000, retries: 1 });
          dropdownOpened = true;
          break;
        } catch (error) {
          console.log(`[ALFA→SAVING] ⚠️ Попытка ${attempt}/3 не удалась: ${error.message}`);
          if (attempt < 3) {
            await this.sleep(2000);
          }
        }
      }

      if (!dropdownOpened) {
        throw new Error('Не удалось открыть выпадающий список счетов после 3 попыток');
      }

      // Support both "Расчётный" and "Текущий счёт" naming
      const sourceAccountName = 'Текущий счёт ··7167';
      const sourceAccountDigits = '7167';

      let sourceAccountSelected = false;
      for (let attempt = 1; attempt <= 3; attempt++) {
        console.log(`[ALFA→SAVING] Попытка ${attempt}/3: Выбор счёта "${sourceAccountName}"`);

        sourceAccountSelected = await this.page.evaluate(selectionData => {
          const normalize = text =>
            (text || '')
              .replace(/\u00A0/g, ' ')
              .replace(/[·•]/g, ' ')
              .replace(/ё/g, 'е')
              .replace(/Ё/g, 'Е')
              .replace(/\s+/g, ' ')
              .trim()
              .toLowerCase();

          const options = Array.from(document.querySelectorAll('div[data-test-id="src-account-option"]'));
          console.log(`Found ${options.length} account options`);

          const targetOption = options.find(opt => {
            const optionText = normalize(opt.textContent);
            console.log(`Checking option: "${optionText}"`);

            // Try matching by digits first (most reliable)
            if (selectionData.accountDigits) {
              const digits = (opt.textContent || '').replace(/\D/g, '');
              if (digits.includes(selectionData.accountDigits)) {
                console.log(`Matched by digits: ${selectionData.accountDigits}`);
                return true;
              }
            }

            // Try matching by name (with normalization)
            const normalizedTargetName = normalize(selectionData.accountName);
            if (normalizedTargetName && optionText.includes(normalizedTargetName)) {
              console.log(`Matched by name: ${normalizedTargetName}`);
              return true;
            }

            // Try alternative names
            if (optionText.includes('текущий') && optionText.includes('7167')) {
              console.log('Matched by "текущий" + digits');
              return true;
            }
            if (optionText.includes('расчетный') && optionText.includes('7167')) {
              console.log('Matched by "расчетный" + digits');
              return true;
            }

            return false;
          });

          if (!targetOption || !(targetOption instanceof HTMLElement)) {
            console.log('No matching option found');
            return false;
          }

          console.log('Target option found, scrolling into view');
          targetOption.scrollIntoView({ block: 'center' });

          const clickable = targetOption.querySelector('section[tabindex], button, [role="option"]');
          if (clickable instanceof HTMLElement) {
            console.log('Clicking on nested clickable element');
            clickable.click();
            return true;
          }

          if (typeof targetOption.click === 'function') {
            console.log('Clicking on option element');
            targetOption.click();
            return true;
          }

          console.log('Dispatching click event');
          targetOption.dispatchEvent(new MouseEvent('click', { bubbles: true }));
          return true;
        }, { accountName: sourceAccountName, accountDigits: sourceAccountDigits });

        if (sourceAccountSelected) {
          console.log(`[ALFA→SAVING] ✅ Счёт выбран на попытке ${attempt}/3`);
          break;
        }

        if (attempt < 3) {
          console.log(`[ALFA→SAVING] ⚠️ Попытка ${attempt}/3 не удалась, повтор...`);
          await this.sleep(2000);
          await ensureAccountDropdownOpen();
        }
      }

      if (!sourceAccountSelected) {
        throw new Error(`Не удалось выбрать счёт списания "${sourceAccountName}" после 3 попыток`);
      }

      await waitBetweenSteps();

      console.log('[ALFA→SAVING] Этап 3/5: Нажатие "Всё"');
      await this.page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        const allButton = buttons.find(btn => btn.textContent.includes('Всё'));
        if (allButton) allButton.click();
      });

      await waitBetweenSteps();

      console.log('[ALFA→SAVING] Этап 4/5: Нажатие "Перевести"');
      await this.waitForSelectorWithRetry('button[data-test-id="payment-button"]', { timeout: 15000, retries: 3 });
      await this.page.click('button[data-test-id="payment-button"]');

      await waitBetweenSteps();

      console.log('[ALFA→SAVING] Этап 5/5: Проверка успешности перевода');
      await waitBetweenSteps();

      console.log('[ALFA→SAVING] ✅ Перевод успешно завершён');

      return { success: true, amount };

    } catch (error) {
      console.error('[ALFA→SAVING] ❌ Ошибка:', error.message);

      // Take error screenshot
      await this.takeScreenshot('alfa-to-saving-error');

      throw error;
    }
  }

  /**
   * Transfer from Alfa saving account to Alfa debit account
   */
  async transferFromAlfaSaving(savingAccountId, toAccountName, amount) {
    try {
      const amountLabel = amount != null ? `${amount}₽` : 'полного баланса';
      console.log(`[SAVING→ALFA] Начало перевода ${amountLabel} с накопительного счёта`);

      if (!this.authenticated) {
        throw new Error('Не авторизован в Альфа-Банке');
      }

      const waitBetweenSteps = async () => {
        await this.sleep(15000);
      };

      console.log('[SAVING→ALFA] Этап 1/6: Переход на страницу перевода между своими счетами');
      const transferUrl = `https://web.alfabank.ru/transfers/account-to-account?sourceAccount=${savingAccountId}`;
      await this.page.goto(transferUrl, { waitUntil: 'domcontentloaded', timeout: 60000 });
      await waitBetweenSteps();

      console.log('[SAVING→ALFA] Открытие поля "Куда"...');
      console.log(`[SAVING→ALFA] Этап 2/6: Выбор счёта назначения "${toAccountName}"`);
      const destOptionSelector = 'div[data-test-id="dest-account-option"]';
      const destListSelector = 'div[data-test-id="dest-account-options-list"]';

      const ensureDestinationDropdownOpen = async () => {
        const optionVisible = await this.page.$(destOptionSelector);
        if (optionVisible) {
          await optionVisible.dispose(); // MEMORY FIX: dispose handle
          return;
        }

        const triggerSelectors = [
          '[data-test-id="dest-account-select"]',
          '[data-test-id="dest-account-selector"]',
          '[data-test-id="dest-account-dropdown"]',
          '[data-test-id="dest-account"] button',
          '[data-test-id="dest-account-field"]',
          'button[aria-haspopup="listbox"]',
          '[aria-haspopup="listbox"][role="combobox"]',
          '[data-test-id="dest-account-options-trigger"]'
        ];

        const clickTrigger = async selector => {
          const clicked = await this.page.evaluate(sel => {
            const el = document.querySelector(sel);
            if (!el) return false;

            if (typeof el.click === 'function') {
              el.click();
              return true;
            }

            if (el instanceof SVGElement) {
              el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
              return true;
            }

            return false;
          }, selector);

          if (!clicked) {
            return false;
          }

          return true;
        };

        for (const selector of triggerSelectors) {
          const opened = await clickTrigger(selector);
          if (opened) {
            await this.sleep(500);
            const check = await this.page.$(destOptionSelector);
            if (check) {
              await check.dispose(); // MEMORY FIX: dispose handle
              return;
            }
          }
        }

        // Last resort: click via DOM evaluation on the specific field
        const fieldOpened = await this.page.evaluate(() => {
          const field = document.querySelector('[data-test-id="dest-account-field"]');
          if (field instanceof HTMLElement || field instanceof SVGElement) {
            if (typeof field.click === 'function') {
              field.click();
            } else {
              field.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            }
            return true;
          }
          const container = document.querySelector('[data-test-id="dest-account"]');
          if (container instanceof HTMLElement || container instanceof SVGElement) {
            if (typeof container.click === 'function') {
              container.click();
            } else {
              container.dispatchEvent(new MouseEvent('click', { bubbles: true }));
            }
            return true;
          }
          return false;
        });
        if (fieldOpened) {
          await this.sleep(500);
          const check = await this.page.$(destOptionSelector);
          if (check) {
            await check.dispose(); // MEMORY FIX: dispose handle
            return;
          }
        }

        const fallbackTriggered = await this.page.evaluate(() => {
          // MEMORY OPTIMIZED: iterate NodeList directly, don't create array
          const candidates = document.querySelectorAll('[aria-haspopup="listbox"], [data-test-id]');
          for (const candidate of candidates) {
            if (
              !(candidate instanceof HTMLElement) &&
              !(candidate instanceof SVGElement)
            ) {
              continue;
            }
            const dataset = candidate.dataset || {};
            const matchesDataset = Object.keys(dataset).some(key =>
              key.toLowerCase().includes('dest') && key.toLowerCase().includes('account')
            );
            if (matchesDataset || candidate.getAttribute('role') === 'combobox') {
              if (typeof candidate.click === 'function') {
                candidate.click();
              } else {
                candidate.dispatchEvent(new MouseEvent('click', { bubbles: true }));
              }
              return true;
            }
          }
          return false;
        });
        if (fallbackTriggered) {
          await this.sleep(500);
        }
      };

      await ensureDestinationDropdownOpen();
      await this.waitForSelectorWithRetry(`${destListSelector}, ${destOptionSelector}`, { timeout: 20000, retries: 3 });
      await ensureDestinationDropdownOpen();

      const destinationDigits = (toAccountName || '').replace(/\D/g, '').slice(-4);
      const destinationSelected = await this.page.evaluate(selectionData => {
        const normalize = text =>
          (text || '')
            .replace(/\u00A0/g, ' ')
            .replace(/[·•]/g, ' ')
            .replace(/\s+/g, ' ')
            .trim()
            .toLowerCase();

        const targetNormalized = normalize(selectionData.targetName);
        const options = Array.from(document.querySelectorAll('div[data-test-id="dest-account-option"]'));
        const targetOption = options.find(opt => {
          const optionText = normalize(opt.textContent);
          if (targetNormalized && optionText.includes(targetNormalized)) {
            return true;
          }

          if (selectionData.targetDigits) {
            const digits = (opt.textContent || '').replace(/\D/g, '');
            if (digits.endsWith(selectionData.targetDigits)) {
              return true;
            }
          }

          return false;
        });

        if (!targetOption || !(targetOption instanceof HTMLElement)) {
          return false;
        }

        targetOption.scrollIntoView({ block: 'center' });

        const clickableSection = targetOption.querySelector('section[tabindex], button, [role="option"]');
        if (clickableSection instanceof HTMLElement) {
          clickableSection.click();
          return true;
        }

        if (typeof targetOption.click === 'function') {
          targetOption.click();
          return true;
        }

        targetOption.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        return true;
      }, { targetName: toAccountName, targetDigits: destinationDigits });

      if (!destinationSelected) {
        throw new Error(`Не удалось выбрать счёт назначения "${toAccountName}"`);
      }

      await waitBetweenSteps();

      console.log('[SAVING→ALFA] Этап 3/6: Нажатие "Всё"');
      const allClicked = await this.page.evaluate(() => {
        // MEMORY OPTIMIZED: use NodeIterator instead of creating array
        const buttons = document.querySelectorAll('button');
        for (const btn of buttons) {
          if (btn.textContent && btn.textContent.includes('Всё')) {
            btn.click();
            return true;
          }
        }
        return false;
      });

      if (!allClicked) {
        throw new Error('Не удалось нажать кнопку "Всё"');
      }

      await waitBetweenSteps();

      console.log('[SAVING→ALFA] Этап 4/6: Нажатие "Перевести" (с retry при ошибках)');

      const maxRetries = 5;
      let transferSuccess = false;

      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        console.log(`[SAVING→ALFA] Попытка ${attempt}/${maxRetries}: Нажатие "Перевести"`);

        await this.waitForSelectorWithRetry('button[data-test-id="payment-button"]', { timeout: 15000, retries: 3 });
        await this.page.click('button[data-test-id="payment-button"]');

        // Wait 15 seconds and check for error message
        console.log('[SAVING→ALFA] Ожидание 15 секунд для проверки на ошибку...');
        await this.sleep(15000);

        // Check if error message appeared (MEMORY OPTIMIZED: use TreeWalker instead of querySelectorAll)
        const hasError = await this.page.evaluate(() => {
          const errorText = 'Извините, что-то пошло не так';

          // Use TreeWalker for memory-efficient DOM traversal
          const walker = document.createTreeWalker(
            document.body,
            NodeFilter.SHOW_ELEMENT,
            {
              acceptNode: (node) => {
                if (!node.textContent || !node.textContent.includes(errorText)) {
                  return NodeFilter.FILTER_SKIP;
                }
                return NodeFilter.FILTER_ACCEPT;
              }
            }
          );

          let currentNode;
          while (currentNode = walker.nextNode()) {
            const style = window.getComputedStyle(currentNode);
            if (style.display === 'none' || style.visibility === 'hidden' || Number(style.opacity) === 0) {
              continue;
            }
            const rect = currentNode.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              return true;
            }
          }

          return false;
        });

        if (hasError) {
          console.log(`[SAVING→ALFA] ⚠️ Обнаружена ошибка "Извините, что-то пошло не так" на попытке ${attempt}`);

          if (attempt === maxRetries) {
            throw new Error('Превышено максимальное количество попыток перевода (5). Ошибка "Извините, что-то пошло не так" не исчезла.');
          }

          // Wait a bit before retry
          console.log('[SAVING→ALFA] Ожидание 5 секунд перед повторной попыткой...');
          await this.sleep(5000);
          continue; // Retry
        }

        // No error found - transfer successful
        console.log(`[SAVING→ALFA] ✅ Ошибки не обнаружено, перевод выполнен успешно`);
        transferSuccess = true;
        break;
      }

      if (!transferSuccess) {
        throw new Error('Не удалось выполнить перевод после всех попыток');
      }

      console.log('[SAVING→ALFA] Этап 5/6: Нажатие "Готово"');
      await this.waitForSelectorWithRetry('button[data-test-id="ready-button"]', { timeout: 15000, retries: 3 });
      await this.page.click('button[data-test-id="ready-button"]');
      await this.sleep(10000);

      console.log('[SAVING→ALFA] Этап 6/6: Проверка успешности перевода');

      // MEMORY OPTIMIZATION: Only GC, no cache/cookie clearing (causes logout)
      if (global.gc) {
        console.log('[SAVING→ALFA] 🧹 Running garbage collection...');
        global.gc();
      }

      console.log('[SAVING→ALFA] ✅ Перевод успешно завершён');

      return { success: true, amount };

    } catch (error) {
      console.error('[SAVING→ALFA] ❌ Ошибка:', error.message);

      await this.takeScreenshot('saving-to-alfa-error');

      throw error;
    }
  }

  /**
   * Transfer from Alfa to T-Bank via SBP
   * @param {string} savingAccountId - Alfa account identifier (used for logging/tracing)
   * @param {string} recipientPhone - Phone number linked to T-Bank for SBP transfer
   * @param {?number} amount - Optional transfer amount (if null, full balance is used)
   */
  async transferToTBankSBP(savingAccountId, recipientPhone, amount) {
    try {
      const requestedAmountLabel = amount != null ? `${amount}₽` : 'полного баланса';
      console.log(`[ALFA→TBANK] Начало перевода ${requestedAmountLabel} на Т-Банк через СБП`);

      if (!this.authenticated) {
        throw new Error('Не авторизован в Альфа-Банке');
      }

      const waitBetweenSteps = async () => {
        await this.sleep(15000);
      };

      console.log('[ALFA→TBANK] Этап 1/11: Переходим на страницу переводов по телефону');
      await this.page.goto('https://web.alfabank.ru/transfers/phone', {
        waitUntil: 'domcontentloaded',
        timeout: 60000
      });
      await waitBetweenSteps();

      console.log('[ALFA→TBANK] Ищем активный iframe формы перевода...');
      let transferFrame = await this.waitForFrame(frame => {
        const url = frame.url() || '';
        return url.includes('/transfers/phone') || url.includes('host-ui') || url.includes('transfer-by-phone');
      }, {
        timeout: 30000,
        description: 'transfer-by-phone iframe'
      }).catch(() => null);


      if (!transferFrame) {
        console.log('[ALFA→TBANK] ⚠️ iframe with transfer form not detected yet, will scan all frames.');
      }

      console.log('[ALFA→TBANK] Этап 2/11: Клик по полю телефона и ввод номера');
      const trimmedPhone = typeof recipientPhone === 'string' ? recipientPhone.trim() : '';
      const normalizedPhone = trimmedPhone
        ? (trimmedPhone.startsWith('+') ? trimmedPhone : `+${trimmedPhone}`)
        : '';

      // Ensure we have a transfer frame to work with
      if (!transferFrame) {
        // Try to use main page if iframe not found
        transferFrame = this.page.mainFrame();
        console.log('[ALFA→TBANK] ⚠️ Using main frame for phone input');
      }

      // Click on phone input field coordinates (566, 472) twice with 500ms delay
      console.log('[ALFA→TBANK] Клик по координатам поля телефона: (566, 472)');
      await transferFrame.evaluate(() => {
        window.scrollTo(0, 0);
      });
      await this.sleep(500);

      await this.page.mouse.click(566, 472);
      console.log('[ALFA→TBANK] Первый клик выполнен');
      await this.sleep(500);

      await this.page.mouse.click(566, 472);
      console.log('[ALFA→TBANK] Второй клик выполнен');
      await this.sleep(500);

      // Type phone number character by character (like SMS code input)
      console.log(`[ALFA→TBANK] Ввод номера телефона: ${normalizedPhone}`);
      for (let i = 0; i < normalizedPhone.length; i++) {
        const char = normalizedPhone[i];
        await this.page.keyboard.type(char, { delay: 100 });
        await this.sleep(50 + Math.random() * 50);
        console.log(`[ALFA→TBANK] ⌨️ Введён символ ${i + 1}/${normalizedPhone.length}: "${char}"`);
      }

      console.log('[ALFA→TBANK] ✅ Номер телефона введён');
      await waitBetweenSteps();

      console.log('[ALFA→TBANK] Этап 3/11: Пропускаем (используем клики по координатам)');
      // Этап 3 удалён: поиск шаблона "Перевод в Т-Банк" не нужен, используем клики по координатам
      // ensureRecipientOptionsVisible удалена: не нужна, используем клики по координатам

      console.log('[ALFA→TBANK] Этап 4/11: Клик по банку "Т-Банк"');

      // Wait for bank list to potentially load
      await this.sleep(3000);

      // Click on T-Bank option coordinates (887, 616) twice with 500ms delay
      console.log('[ALFA→TBANK] Клик по координатам Т-Банка: (887, 616)');

      await this.page.mouse.click(887, 616);
      console.log('[ALFA→TBANK] Первый клик по Т-Банку выполнен');
      await this.sleep(500);

      await this.page.mouse.click(887, 616);
      console.log('[ALFA→TBANK] Второй клик по Т-Банку выполнен');

      console.log('[ALFA→TBANK] ✅ Банк "Т-Банк" выбран');
      await waitBetweenSteps();

      console.log('[ALFA→TBANK] Этап 5/11: Получение доступного баланса');
      const accountBalance = await transferFrame.evaluate(() => {
        const amountElement = document.querySelector('span[data-test-id="amount"]');
        return amountElement ? amountElement.textContent : '0';
      });
      console.log(`[ALFA→TBANK] Баланс счёта: ${accountBalance}`);

      let transferAmount = amount != null ? Number(String(amount).replace(',', '.')) : this.parseMoneyString(accountBalance);
      if (!Number.isFinite(transferAmount) || transferAmount <= 0) {
        throw new Error('Не удалось определить сумму перевода');
      }
      transferAmount = Math.round(transferAmount * 100) / 100;
      console.log(`[ALFA→TBANK] Используем сумму перевода: ${transferAmount} RUB`);

      await waitBetweenSteps();

      console.log('[ALFA→TBANK] Этап 6/11: Вводим сумму');
      const amountInputHandle = await this.waitForSelectorWithRetry('input[name="amount"]', {
        timeout: 15000,
        retries: 3,
        targetFrame: transferFrame
      });
      const amountInputValue = transferAmount.toFixed(2).replace('.', ',');
      await amountInputHandle.evaluate((input, value) => {
        const nativeSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
        nativeSetter.call(input, '');
        input.dispatchEvent(new Event('input', { bubbles: true }));
        nativeSetter.call(input, value);
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      }, amountInputValue);
      await amountInputHandle.dispose();
      await waitBetweenSteps();

      console.log('[ALFA→TBANK] Этап 7/11: Нажимаем "Продолжить"');
      const submitButtonHandle = await this.waitForSelectorWithRetry('button[type="submit"]', {
        timeout: 15000,
        retries: 3,
        targetFrame: transferFrame
      });
      await submitButtonHandle.click();
      await submitButtonHandle.dispose();
      await waitBetweenSteps();

      console.log('[ALFA→TBANK] Этап 8/11: Нажимаем "Подтвердить"');
      const confirmationButtonHandle = await this.waitForSelectorWithRetry('button[data-test-id="transfer-by-phone-confirmation-submit-btn"]', {
        timeout: 15000,
        retries: 3,
        targetFrame: transferFrame
      });
      await confirmationButtonHandle.click();
      await confirmationButtonHandle.dispose();
      await waitBetweenSteps();

      console.log('[ALFA→TBANK] Этап 9/11: Ожидание SMS-кода от Т-Банка');
      this.pendingInputType = 'alfa_sms';
      this.pendingInputData = {
        message: 'Ожидание SMS-кода для подтверждения перевода'
      };
      await this.waitForAlfaSMSCode(120000, 3); // 2 minutes timeout per attempt, max 3 retries

      console.log('[ALFA→TBANK] Этап 10/11: Ввод SMS-кода');
      console.log(`[ALFA→TBANK] 📝 SMS-код для ввода: "${this.alfaSmsCode}" (длина: ${this.alfaSmsCode ? this.alfaSmsCode.length : 0})`);

      const smsInputHandle = await this.waitForSelectorWithRetry('input.KRyR4.uokLS', {
        timeout: 15000,
        retries: 3,
        targetFrame: transferFrame
      });
      await smsInputHandle.dispose();
      const codeInputs = await transferFrame.$$('input.KRyR4.uokLS');

      console.log(`[ALFA→TBANK] Найдено ${codeInputs.length} полей для ввода кода`);

      // Log all input fields found on the page
      const allInputs = await transferFrame.$$('input');
      console.log(`[ALFA→TBANK] Количество input элементов в текущем фрейме: ${allInputs.length}`);

      for (let i = 0; i < allInputs.length; i++) {
        const inputInfo = await transferFrame.evaluate(el => {
          return {
            type: el.type,
            className: el.className,
            name: el.name,
            id: el.id,
            placeholder: el.placeholder,
            value: el.value
          };
        }, allInputs[i]);
        console.log(`[ALFA→TBANK] Input ${i + 1}:`, JSON.stringify(inputInfo));
      }

      // Enter code digit by digit with focus
      for (let i = 0; i < 4 && i < this.alfaSmsCode.length; i++) {
        const digit = this.alfaSmsCode[i];
        console.log(`[ALFA→TBANK] ⌨️  Ввод цифры ${i + 1}/4: "${digit}"`);

        // Click to focus on the input field
        await codeInputs[i].click();
        await this.sleep(150);

        // Focus explicitly
        await codeInputs[i].focus();
        await this.sleep(150);

        // Type the digit
        await codeInputs[i].type(digit, { delay: 100 });
        await this.sleep(350);

        console.log(`[ALFA→TBANK] ✅ Цифра ${i + 1}/4 введена и обработана`);
      }

      console.log('[ALFA→TBANK] ✅ SMS-код введён, ожидание обработки...');
      await this.sleep(3000);

      console.log('[ALFA→TBANK] Этап 11/11: Проверка успешности перевода');

      // Check for error messages
      const errorMessages = await transferFrame.evaluate(() => {
        const errors = [];
        document.querySelectorAll('[class*="error"], [class*="Error"], .error-message, .alert-danger').forEach(el => {
          if (el.textContent.trim()) {
            errors.push(el.textContent.trim());
          }
        });
        return errors;
      });

      if (errorMessages.length > 0) {
        console.log('[ALFA→TBANK] ⚠️ Обнаружены сообщения об ошибках на странице:', errorMessages);
      } else {
        console.log('[ALFA→TBANK] ✅ Ошибок на странице не обнаружено');
      }

      this.pendingInputType = null;
      this.pendingInputData = null;

      // Clear SMS code from memory after successful transfer
      console.log('[ALFA→TBANK] 🧹 Очистка SMS-кода из памяти после успешного перевода');
      this.alfaSmsCode = null;

      console.log('[ALFA→TBANK] ✅ Перевод успешно завершён');

      return { success: true, amount: transferAmount };

    } catch (error) {
      console.error('[ALFA→TBANK] ❌ Ошибка:', error.message);

      await this.takeScreenshot('alfa-to-tbank-error');

      this.pendingInputType = null;
      this.pendingInputData = null;

      // Clear SMS code from memory on error to avoid reusing old codes
      console.log('[ALFA→TBANK] 🧹 Очистка SMS-кода из памяти после ошибки');
      this.alfaSmsCode = null;

      throw error;
    }
  }

  /**
   * Get pending input type
   */
  getPendingInputType() {
    return this.pendingInputType;
  }

  /**
   * Get pending input data
   */
  getPendingInputData() {
    return this.pendingInputData;
  }

  /**
   * Get session stats
   */
  getSessionStats() {
    const now = Date.now();
    const lifetimeMs = now - this.sessionStartTime;
    const lifetimeMinutes = Math.floor(lifetimeMs / 1000 / 60);

    return {
      authenticated: this.authenticated,
      lifetimeMinutes,
      lifetimeMs
    };
  }

  /**
   * Close browser
   */
  async close() {
    try {
      if (this.browser) {
        try {
          // Try graceful close first
          await this.browser.close();
          console.log('[ALFA-BROWSER] ✅ Браузер закрыт (graceful)');
        } catch (browserCloseError) {
          console.log('[ALFA-BROWSER] ⚠️ Graceful close failed, attempting force disconnect:', browserCloseError.message);

          // If graceful close fails, try to disconnect
          try {
            if (this.browser && typeof this.browser.disconnect === 'function') {
              this.browser.disconnect();
              console.log('[ALFA-BROWSER] ✅ Браузер отключён (disconnect)');
            }
          } catch (disconnectError) {
            console.log('[ALFA-BROWSER] ⚠️ Disconnect also failed:', disconnectError.message);
          }
        }

        this.browser = null;
        this.page = null;
      }

      // NOTE: Removed force kill commands (pkill -9, taskkill /F) as they can:
      // 1. Kill ALL Chrome processes on the server (including other sessions)
      // 2. Cause server restart on platforms like Render
      // 3. Puppeteer already handles process cleanup correctly via browser.close()

    } catch (error) {
      console.error('[ALFA-BROWSER] Ошибка в методе close():', error.message);
      // Don't rethrow - we want cleanup to always succeed
    }
  }
}
