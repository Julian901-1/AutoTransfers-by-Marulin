import puppeteer from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import dotenv from 'dotenv';

dotenv.config();

// Use stealth plugin to avoid detection
puppeteer.use(StealthPlugin());

const ACCOUNT_REQUIRED_PARAMS = encodeURIComponent(JSON.stringify(['accountId']));

function requireEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Environment variable ${name} is required for T-Bank automation`);
  }
  return value;
}

function buildTransferBetweenAccountsUrl(accountId) {
  const predefined = encodeURIComponent(JSON.stringify({
    account: accountId,
    moneyAmount: ':moneyAmount'
  }));

  return `https://www.tbank.ru/mybank/payments/transfer-between-accounts/?predefined=${predefined}&requiredParams=${ACCOUNT_REQUIRED_PARAMS}&internal_source=quick_transfers`;
}

function buildSbpTransferUrl(accountId, phone) {
  const normalizedPhone = phone.startsWith('+') ? phone : `+${phone}`;
  const predefined = encodeURIComponent(JSON.stringify({
    accountId,
    moneyAmount: ':moneyAmount',
    phone: normalizedPhone
  }));

  return `https://www.tbank.ru/mybank/payments/persons/phone/?predefined=${predefined}&requiredParams=${ACCOUNT_REQUIRED_PARAMS}`;
}

const MIN_TBANK_SBP_RESERVE_RUB = 2000;

/**
 * T-Bank automation using Puppeteer with anti-detection
 */
export class TBankAutomation {
  constructor({ username, phone, password, encryptionService, onAuthenticated, existingBrowser = null, existingPage = null }) {
    this.username = username;
    this.encryptedPhone = phone;
    this.encryptedPassword = password;
    this.encryptionService = encryptionService;
    this.onAuthenticated = onAuthenticated; // Callback to mark session as authenticated

    // Allow reusing existing browser/page from Alfa automation
    this.browser = existingBrowser;
    this.page = existingPage;
    this.reusingBrowser = !!(existingBrowser && existingPage);

    this.sessionActive = false;

    // Pending input system - now fully dynamic
    this.pendingInputResolve = null;
    this.pendingInputType = 'waiting'; // 'waiting', 'sms', 'dynamic-question', null (null = login complete)
    this.pendingInputData = null; // Question text and field type for dynamic questions
  }

  /**
   * Initialize browser instance
   */
  async init() {
    if (this.browser && this.page) {
      if (this.reusingBrowser) {
        console.log(`[TBANK] Reusing existing browser for user ${this.username}`);
      }
      return;
    }

    console.log(`[TBANK] Initializing new browser for user ${this.username}`);

    // DISK SPACE OPTIMIZATION: Removed userDataDir to avoid creating persistent files
    // Each browser launch is now stateless and creates no disk files

    const launchOptions = {
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-blink-features=AutomationControlled',
        '--disable-features=IsolateOrigins,site-per-process',
        '--disable-gpu',
        '--disable-web-security',
        '--disable-features=VizDisplayCompositor',
        '--disable-backgrounding-occluded-windows',
        '--disable-renderer-backgrounding',
        '--disable-background-timer-throttling',
        '--disable-hang-monitor',
        '--disable-client-side-phishing-detection',
        '--disable-sync',
        '--disable-extensions',
        '--disable-translate',
        '--metrics-recording-only',
        '--mute-audio',
        '--no-first-run',
        '--safebrowsing-disable-auto-update',
        '--disable-default-apps',
        '--no-zygote',
        '--window-size=1366,768',
        '--disable-webrtc',
        '--disable-webrtc-hw-encoding',
        '--disable-webrtc-hw-decoding',
        '--lang=ru-RU',
        '--timezone=Europe/Moscow',
        // MEMORY OPTIMIZATION: Set memory limits for V8 engine
        '--max-old-space-size=256',
        '--js-flags=--max-old-space-size=256'
        // MEMORY OPTIMIZATION: Removed '--single-process' as it causes memory leaks
      ],
      defaultViewport: {
        width: 1366,
        height: 768
      }
      // DISK SPACE OPTIMIZATION: No userDataDir - stateless browser
    };

    // IMPORTANT: puppeteer-core requires executablePath
    if (process.env.PUPPETEER_EXECUTABLE_PATH) {
      launchOptions.executablePath = process.env.PUPPETEER_EXECUTABLE_PATH;
      console.log(`[TBANK] Using Chrome from: ${process.env.PUPPETEER_EXECUTABLE_PATH}`);
    } else {
      throw new Error('PUPPETEER_EXECUTABLE_PATH environment variable is required when using puppeteer-core');
    }

    this.browser = await puppeteer.launch(launchOptions);
    this.page = await this.browser.newPage();

    // MEMORY OPTIMIZATION: Disabled page console logging to reduce memory usage
    // this.page.on('console', msg => {
    //   const text = msg.text();
    //   if (text.includes('Found box') || text.includes('matching one of selectors')) {
    //     return;
    //   }
    //   console.log('PAGE LOG:', text);
    // });

    // Block images, fonts to save memory
    await this.page.setRequestInterception(true);
    this.page.on('request', (request) => {
      const resourceType = request.resourceType();
      if (['image', 'font', 'media'].includes(resourceType)) {
        request.abort();
      } else {
        request.continue();
      }
    });

    await this.page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
    );

    await this.page.setExtraHTTPHeaders({
      'Accept-Language': 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
      'Accept-Encoding': 'gzip, deflate, br',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
      'Sec-Fetch-Site': 'none',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-User': '?1',
      'Sec-Fetch-Dest': 'document',
      'Upgrade-Insecure-Requests': '1',
      'Cache-Control': 'max-age=0'
    });

    await this.page.evaluateOnNewDocument(() => {
      Object.defineProperty(navigator, 'webdriver', {
        get: () => false
      });
      Object.defineProperty(navigator, 'plugins', {
        get: () => [1, 2, 3, 4, 5]
      });
      Object.defineProperty(navigator, 'languages', {
        get: () => ['ru-RU', 'ru', 'en-US', 'en']
      });
    });

    console.log('[TBANK] Browser initialized successfully');
  }

  /**
   * Login to T-Bank
   */
  async login() {
    try {
      await this.init();

      // If encryptionService is null, use phone directly (for test endpoints)
      const phone = this.encryptionService
        ? this.encryptionService.decrypt(this.encryptedPhone)
        : this.encryptedPhone;

      console.log(`[TBANK] Navigating to login page...`);
      await this.page.goto(process.env.TBANK_LOGIN_URL, {
        waitUntil: 'networkidle2',
        timeout: parseInt(process.env.PUPPETEER_TIMEOUT)
      });

      console.log(`[TBANK] ✅ Page loaded, current URL: ${this.page.url()}`);

      // Wait for possible redirects to complete
      console.log('[TBANK] ⏳ Waiting for page to stabilize (potential redirects)...');
      await new Promise(resolve => setTimeout(resolve, 3000));

      console.log(`[TBANK] 📍 Final URL after stabilization: ${this.page.url()}`);


      // Step 1: Enter phone number
      console.log('[TBANK] Step 1: Waiting for phone input field...');
      try {
        await this.page.waitForSelector('[automation-id="phone-input"]', { timeout: 10000 });
      } catch (error) {
        console.error('[TBANK] ❌ Phone input selector not found!');
        console.error('[TBANK] Error:', error.message);

        // Try alternative selectors
        console.log('[TBANK] Trying alternative selectors...');
        const altSelectors = [
          'input[type="tel"]',
          'input[name="phone"]',
          'input[placeholder*="телефон"]',
          'input[placeholder*="номер"]'
        ];

        for (const selector of altSelectors) {
          const found = await this.page.$(selector);
          if (found) {
            console.log(`[TBANK] ✅ Found alternative selector: ${selector}`);
            break;
          }
        }

        throw error;
      }
      console.log('[TBANK] Step 1: Entering phone number...');
      await this.typeWithHumanDelay('[automation-id="phone-input"]', phone);
      await new Promise(resolve => setTimeout(resolve, 500 + Math.random() * 1000));
      await this.page.click('[automation-id="button-submit"]');
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Step 2: Wait for SMS code from user
      try {
        await this.page.waitForSelector('[automation-id="otp-input"]', { timeout: 10000 });
        console.log('[TBANK] ✅ Found OTP input field');
        console.log('[TBANK] Step 2: Waiting for SMS code from user...');
        const smsCode = await this.waitForUserInput('sms');
        console.log('[TBANK] Received SMS code, typing into field...');

        await this.typeWithHumanDelay('[automation-id="otp-input"]', smsCode);
        await new Promise(resolve => setTimeout(resolve, 800 + Math.random() * 700));

        const submitButton = await this.page.$('[automation-id="button-submit"]');
        if (submitButton) {
          console.log('[TBANK] Clicking SMS submit button...');
          await submitButton.click();
          // Wait for navigation after SMS submit
          await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(e => {
            console.log('[TBANK] Navigation after SMS timeout or no navigation occurred:', e.message);
          });
          console.log('[TBANK] ✅ SMS step completed, navigation finished');
        }
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (e) {
        console.log('[TBANK] ❌ Step 2 error:', e.message);
      }

      // Dynamic page processing loop after SMS
      console.log('[TBANK] Starting dynamic page processing...');
      let maxIterations = 15; // Защита от бесконечного цикла
      let iteration = 0;

      while (iteration < maxIterations) {
        iteration++;
        console.log(`[TBANK] --- Page detection iteration ${iteration} ---`);

        // Wait for page to stabilize
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Check if already logged in
        const currentUrl = this.page.url();
        console.log('[TBANK] Current URL:', currentUrl);

        // Check for login success indicators
        if (currentUrl.includes('/mybank/') || currentUrl.includes('/accounts') || currentUrl.includes('/main')) {
          console.log('[TBANK] ✅ Detected /mybank/ or accounts page');

          // Login successful - HTML logging removed for performance

          this.sessionActive = true;
          this.pendingInputType = 'completed'; // Signal that login is complete

          // Mark session as authenticated via callback (BEFORE any async operations)
          if (this.onAuthenticated) {
            this.onAuthenticated();
            console.log(`[TBANK] ✅ Called onAuthenticated callback`);
          }

          console.log(`[TBANK] 🎉 pendingInputType set to 'completed' - frontend should detect this`);

          return {
            success: true,
            message: 'Login successful'
          };
        }

        // Check for "Личный кабинет" button (another success indicator)
        const personalCabinetButton = await this.page.$('[data-test="login-button click-area"]');
        if (personalCabinetButton) {
          console.log('[TBANK] ✅ Found "Личный кабинет" button, clicking it...');
          await personalCabinetButton.click();
          await new Promise(resolve => setTimeout(resolve, 3000));

          // After clicking, check if we're on mybank
          const newUrl = this.page.url();
          if (newUrl.includes('/mybank/') || newUrl.includes('/accounts') || newUrl.includes('/main')) {
            console.log('[TBANK] ✅ Successfully navigated to /mybank/');
            this.sessionActive = true;
            this.pendingInputType = 'completed'; // Signal that login is complete

            // Mark session as authenticated via callback
            if (this.onAuthenticated) {
              this.onAuthenticated();
              console.log(`[TBANK] ✅ Called onAuthenticated callback`);
            }

            console.log(`[TBANK] 🎉 pendingInputType set to 'completed' - frontend should detect this`);

            return {
              success: true,
              message: 'Login successful'
            };
          }
          continue;
        }

        // Get page content to analyze what we're looking at (minimal logging to save memory)
        const formTitle = await this.page.$eval('[automation-id="form-title"]', el => el.textContent.trim()).catch(() => null);
        const formDescription = await this.page.$eval('[automation-id="form-description"]', el => el.textContent.trim()).catch(() => null);

        console.log('[TBANK] Detected form title:', formTitle);
        console.log('[TBANK] Detected form description:', formDescription);

        // Check if there's a "Не сейчас" / "Cancel" button to skip optional steps
        const cancelButton = await this.page.$('[automation-id="cancel-button"]');
        if (cancelButton) {
          console.log('[TBANK] ✅ Found "Не сейчас" button - this is an optional step, skipping...');
          console.log(`[TBANK] Skipping optional step: "${formTitle || 'unknown'}"`);
          await cancelButton.click();
          await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 30000 }).catch(e => {
            console.log('[TBANK] Navigation timeout after cancel:', e.message);
          });
          console.log('[TBANK] ✅ Optional step skipped');
          continue;
        }

        // If no cancel button, we need to detect what input is required and ask user
        // Try to find any input field with automation-id
        const inputFields = await this.page.evaluate(() => {
          const inputs = document.querySelectorAll('input[automation-id]');
          return Array.from(inputs).map(input => ({
            automationId: input.getAttribute('automation-id'),
            type: input.type,
            placeholder: input.placeholder,
            name: input.name
          }));
        });

        console.log('[TBANK] Found input fields:', JSON.stringify(inputFields, null, 2));

        // Detect what kind of question this is based on available fields
        if (inputFields.length > 0) {
          const firstInput = inputFields[0];
          let questionText = formTitle || '';
          if (formDescription) {
            questionText += ` (${formDescription})`;
          }

          console.log('[TBANK] ✅ Detected dynamic question that requires user input');
          console.log('[TBANK] Question:', questionText);
          console.log('[TBANK] Input field:', firstInput.automationId);

          // Check if we can auto-answer this question
          let userAnswer = null;

          // Auto-answer for card number question
          if (firstInput.automationId === 'card-input' && process.env.FIXED_TBANK_CARD_NUMBER) {
            console.log('[TBANK] Auto-answering card number question from environment variable');
            userAnswer = process.env.FIXED_TBANK_CARD_NUMBER;
          }

          // If no auto-answer, ask user for input
          if (!userAnswer) {
            userAnswer = await this.waitForUserInput('dynamic-question', {
              question: questionText,
              fieldType: firstInput.automationId,
              inputType: firstInput.type
            });
            console.log('[TBANK] Received answer from user, typing into field...');
          } else {
            console.log('[TBANK] Using auto-answer, typing into field...');
          }

          // Type the answer into the field with human-like delays
          const inputSelector = `[automation-id="${firstInput.automationId}"]`;
          await this.typeWithHumanDelay(inputSelector, userAnswer);
          await new Promise(resolve => setTimeout(resolve, 600 + Math.random() * 800));

          // Submit the form
          const submitButton = await this.page.$('[automation-id="button-submit"]');
          if (submitButton) {
            console.log('[TBANK] Clicking submit button...');
            await submitButton.click();
            await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(e => {
              console.log('[TBANK] Navigation timeout:', e.message);
            });
            console.log('[TBANK] ✅ Answer submitted');
            continue;
          }
        }

        // If no inputs and no cancel button, try clicking any visible links to navigate
        const internetBankLink = await this.page.$('[data-item-name="Интернет-банк"]');
        if (internetBankLink) {
          console.log('[TBANK] Found "Интернет-банк" link, clicking...');
          await internetBankLink.click();
          await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(e => {
            console.log('[TBANK] Navigation timeout:', e.message);
          });
          continue;
        }

        // If nothing detected, we might be stuck - break the loop
        console.log('[TBANK] ⚠️ No recognizable elements found on page, breaking loop...');
        break;
      }

      console.log('[TBANK] ⚠️ Exited dynamic page loop - performing final checks...');

      // Final check: are we logged in?
      const finalUrl = this.page.url();
      if (finalUrl.includes('/mybank/') || finalUrl.includes('/accounts') || finalUrl.includes('/main')) {
        console.log('[TBANK] ✅ Final URL check passed - logged in successfully');
        this.sessionActive = true;
        this.pendingInputType = 'completed'; // Signal that login is complete

        // Mark session as authenticated via callback
        if (this.onAuthenticated) {
          this.onAuthenticated();
          console.log(`[TBANK] ✅ Called onAuthenticated callback`);
        }

        // Track login start for runtime metrics
        console.log(`[TBANK] 🎉 pendingInputType set to 'completed' - frontend should detect this`);

        return {
          success: true,
          message: 'Login successful'
        };
      }

      // If not on mybank yet, check if there's a way to navigate there
      const checkLoginStatus = await this.checkLoginStatus();
      if (checkLoginStatus) {
        console.log('[TBANK] ✅ Login status check passed');
        this.sessionActive = true;
        this.pendingInputType = 'completed'; // Signal that login is complete

        // Mark session as authenticated via callback
        if (this.onAuthenticated) {
          this.onAuthenticated();
          console.log(`[TBANK] ✅ Called onAuthenticated callback`);
        }

        // Track login start for runtime metrics
        console.log(`[TBANK] 🎉 pendingInputType set to 'completed' - frontend should detect this`);

        return {
          success: true,
          message: 'Login successful'
        };
      }

      // Login failed
      console.log('[TBANK] ❌ Login failed - could not reach mybank page');
      this.pendingInputType = 'error';
      return {
        success: false,
        error: 'Login failed - could not complete authentication flow'
      };

    } catch (error) {
      console.error('[TBANK] Login error:', error);
      this.pendingInputType = 'error';
      return {
        success: false,
        error: error.message
      };
    }
  }



  /**
   * Wait for user input dynamically
   * @param {string} type - Type of input ('sms', 'dynamic-question')
   * @param {object|string} [data] - Additional data (e.g., question object for dynamic questions)
   */
  async waitForUserInput(type, data = null) {
    console.log(`[TBANK] Waiting for user to provide ${type}...`);
    if (data) {
      console.log(`[TBANK] Question data:`, JSON.stringify(data, null, 2));
    }
    this.pendingInputType = type;
    this.pendingInputData = data;

    return new Promise((resolve) => {
      this.pendingInputResolve = resolve;
    });
  }

  /**
   * Take base64 screenshot for logging
   * @param {string} context - Context description
   */
  async takeScreenshot(context = 'unknown') {
    if (!this.page) return null;

    try {
      const screenshot = await this.page.screenshot({ encoding: 'base64', type: 'png' });
      console.log(`[TBANK] 📸 [${context}] Screenshot captured (base64 length: ${screenshot.length})`);

      // Log base64 only for error screenshots to help debug issues
      if (context.includes('error')) {
        console.log(`[TBANK] 📸 === SCREENSHOT BASE64 START [${context}] ===`);
        console.log(screenshot);
        console.log(`[TBANK] 📸 === SCREENSHOT BASE64 END [${context}] ===`);
      }

      return screenshot;
    } catch (e) {
      console.log(`[TBANK] ⚠️ [${context}] Could not capture screenshot:`, e.message);
      return null;
    }
  }

  /**
   * Wait for selector with retry logic (for slow page loads)
   * @param {string} selector - CSS selector to wait for
   * @param {Object} options - Options object
   * @param {number} options.timeout - Timeout for each attempt (default: 30000ms)
   * @param {number} options.retries - Number of retry attempts (default: 3)
   * @param {number} options.retryDelay - Delay between retries (default: 5000ms)
   * @param {boolean} options.visible - Wait for element to be visible (default: false)
   * @param {boolean} options.hidden - Wait for element to be hidden (default: false)
   * @returns {Promise<ElementHandle>} - Element handle when found
   */
  async waitForSelectorWithRetry(selector, options = {}) {
    const {
      timeout = 30000,
      retries = 3,
      retryDelay = 5000, // 5 seconds for slow page loads
      visible = false,
      hidden = false
    } = options;

    let lastError;

    for (let attempt = 1; attempt <= retries; attempt++) {
      try {
        console.log(`[TBANK-RETRY] Попытка ${attempt}/${retries}: Ожидание элемента "${selector}"...`);

        const element = await this.page.waitForSelector(selector, {
          timeout,
          visible,
          hidden
        });

        console.log(`[TBANK-RETRY] ✅ Элемент "${selector}" найден на попытке ${attempt}`);
        return element;

      } catch (error) {
        lastError = error;
        console.log(`[TBANK-RETRY] ⚠️ Попытка ${attempt}/${retries} неудачна для "${selector}": ${error.message}`);

        if (attempt < retries) {
          console.log(`[TBANK-RETRY] Ожидание ${retryDelay}ms перед следующей попыткой...`);
          await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
      }
    }

    // All retries failed
    console.log(`[TBANK-RETRY] ❌ Все ${retries} попытки исчерпаны для "${selector}"`);
    throw lastError;
  }

  /**
   * Submit user input from frontend
   */
  submitUserInput(value) {
    if (this.pendingInputResolve) {
      console.log(`[TBANK] User provided ${this.pendingInputType}: ${value}`);
      this.pendingInputResolve(value);
      this.pendingInputResolve = null;
      this.pendingInputType = 'waiting'; // Back to waiting for next step or completion
      return true;
    }
    return false;
  }

  /**
   * Get pending input type
   */
  getPendingInputType() {
    return this.pendingInputType;
  }

  /**
   * Get pending input data (e.g., question text)
   */
  getPendingInputData() {
    return this.pendingInputData || null;
  }

  /**
   * Check if user is logged in
   */
  async checkLoginStatus() {
    try {
      // Check for presence of accounts page elements
      const url = this.page.url();

      if (url.includes('/accounts') || url.includes('/main') || url.includes('/home')) {
        return true;
      }

      // Check for account widgets or user menu
      const accountElements = await this.page.$$('[data-qa="account-card"], .account-item, [class*="account"]');
      return accountElements.length > 0;

    } catch (error) {
      return false;
    }
  }

  /**
   * Simulate realistic mouse movement (Bezier curve)
   */
  async simulateRealisticMouseMovement(fromX, fromY, toX, toY) {
    const steps = 10 + Math.floor(Math.random() * 10); // 10-20 steps

    for (let i = 0; i <= steps; i++) {
      const t = i / steps;

      // Quadratic Bezier curve for natural movement
      const controlX = fromX + (toX - fromX) / 2 + (Math.random() - 0.5) * 100;
      const controlY = fromY + (toY - fromY) / 2 + (Math.random() - 0.5) * 100;

      const x = Math.pow(1 - t, 2) * fromX + 2 * (1 - t) * t * controlX + Math.pow(t, 2) * toX;
      const y = Math.pow(1 - t, 2) * fromY + 2 * (1 - t) * t * controlY + Math.pow(t, 2) * toY;

      await this.page.mouse.move(x, y);
      await new Promise(resolve => setTimeout(resolve, 10 + Math.random() * 20));
    }
  }

  /**
   * Type text with realistic human delays
   */
  async typeWithHumanDelay(selector, text) {
    await this.page.click(selector);
    await new Promise(resolve => setTimeout(resolve, 100 + Math.random() * 200));

    for (const char of text) {
      await this.page.keyboard.type(char);
      // Variable delay between keystrokes (50-150ms)
      const delay = 50 + Math.random() * 100;
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }

  /**
   * Click the first visible element that matches selector and contains the provided text
   * @param {string} selector
   * @param {string} text
   * @param {object} options
   * @param {boolean} [options.exact=false]
   * @param {number} [options.timeout=8000]
   * @returns {Promise<boolean>}
   */
  async clickElementByText(selector, text, { exact = false, timeout = 8000 } = {}) {
    const deadline = Date.now() + timeout;

    while (Date.now() < deadline) {
      const clicked = await this.page.evaluate(
        (cssSelector, searchText, exactMatch) => {
          const normalize = (value) => (value || '')
            .replace(/\u00A0/g, ' ')
            .replace(/\s+/g, ' ')
            .trim();

          const elements = Array.from(document.querySelectorAll(cssSelector));

          for (const element of elements) {
            const textContent = normalize(element.textContent);
            if (!textContent) continue;

            const isMatch = exactMatch
              ? textContent === searchText
              : textContent.includes(searchText);

            if (!isMatch) continue;

            const style = window.getComputedStyle(element);
            if (!style || style.visibility === 'hidden' || style.display === 'none' || Number(style.opacity || '1') === 0) {
              continue;
            }

            const rect = element.getBoundingClientRect();
            if (rect.width === 0 || rect.height === 0) continue;

            const clickable = element.closest('button, [role="button"], a, div[data-test-id="banner-wrapper"]') || element;
            clickable.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
            clickable.click();
            return true;
          }

          return false;
        },
        selector,
        text,
        exact
      );

      if (clicked) return true;

      await new Promise(resolve => setTimeout(resolve, 500));
    }

    return false;
  }



  /**
   * Get all accounts with balances (only debit accounts, excluding credit/investments)
   */
  async getAccounts() {
    try {
      if (!this.sessionActive) {
        throw new Error('Not logged in');
      }

      console.log('[TBANK] Fetching accounts...');

      // Ensure we're on /mybank/ page
      const currentUrl = this.page.url();
      if (!currentUrl.includes('/mybank/')) {
        console.log('[TBANK] Not on /mybank/ page, navigating...');
        await this.page.goto('https://www.tbank.ru/mybank/', {
          waitUntil: 'networkidle2',
          timeout: 30000
        });
      }

      // Wait for page to fully load - increased timeout for slow loading
      console.log('[TBANK] Waiting for page to fully load...');
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Wait for account widgets to load
      console.log('[TBANK] Waiting for account widgets...');
      await this.page.waitForSelector('[data-qa-type^="atomPanel widget"]', {
        timeout: 20000
      });

      // Extract account information
      const accounts = await this.page.evaluate(() => {
        const widgets = Array.from(
          document.querySelectorAll('[data-qa-type^="atomPanel widget"]')
        );

        const balances = [];

        widgets.forEach(widget => {
          const widgetClass = widget.getAttribute('data-qa-type');

          // Skip investments, insurance, and external accounts
          if (widgetClass.includes('widget-investbox') ||
              widgetClass.includes('widget-invest') ||
              widgetClass.includes('widget-insurance') ||
              widgetClass.includes('widget-other')) {
            return;
          }

          // Skip credit cards
          if (widgetClass.includes('widget-credit')) {
            return;
          }

          // Only process debit accounts
          if (widgetClass.includes('widget-debit')) {
            const nameEl = widget.querySelector('[data-qa-type="subtitle"] span');
            const balanceEl = widget.querySelector('[data-qa-type="title"] [data-sensitive="true"]');

            if (nameEl && balanceEl) {
              const name = nameEl.textContent.trim();
              const balanceText = balanceEl.textContent.trim();

              // Extract widget ID
              const widgetId = widgetClass.match(/widget-(\d+)/)?.[1] || 'unknown';

              // Parse balance (remove &nbsp; and convert to number)
              const balanceClean = balanceText.replace(/\u00A0/g, '').replace(/\s/g, '');
              const balanceValue = parseFloat(balanceClean.replace(/[^\d,]/g, '').replace(',', '.')) || 0;

              balances.push({
                id: widgetId,
                name: name,
                balance: balanceValue,
                balanceFormatted: balanceText,
                type: 'debit',
                currency: 'RUB'
              });
            }
          }
        });

        return balances;
      });

      console.log(`[TBANK] ✅ Found ${accounts.length} debit accounts for processing`);

      // Log each account
      accounts.forEach(acc => {
        console.log(`[TBANK] ✅ [BALANCE] ${acc.name}: ${acc.balanceFormatted}`);
      });

      console.log('[TBANK] 📊 Account details:', JSON.stringify(accounts, null, 2));

      return accounts;

    } catch (error) {
      console.error('[TBANK] Error getting accounts:', error);
      throw error;
    }
  }

  /**
   * Get all saving accounts (накопительные счета) from /mybank/ page
   */
  async getSavingAccounts() {
    try {
      if (!this.sessionActive) {
        throw new Error('Not logged in');
      }

      console.log('[TBANK] Fetching saving accounts...');

      // Ensure we're on /mybank/ page
      const currentUrl = this.page.url();
      if (!currentUrl.includes('/mybank/')) {
        console.log('[TBANK] Not on /mybank/ page, navigating...');
        await this.page.goto('https://www.tbank.ru/mybank/', {
          waitUntil: 'networkidle2',
          timeout: 30000
        });
      }

      // Wait for page to fully load
      console.log('[TBANK] Waiting for page to fully load...');
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Wait for account widgets to load
      console.log('[TBANK] Waiting for account widgets...');
      await this.page.waitForSelector('[data-qa-type^="atomPanel widget"]', {
        timeout: 20000
      });

      // Extract saving account information
      const savingAccounts = await this.page.evaluate(() => {
        const widgets = Array.from(
          document.querySelectorAll('[data-qa-type^="atomPanel widget"]')
        );

        const savings = [];

        widgets.forEach(widget => {
          const widgetClass = widget.getAttribute('data-qa-type');

          // Only process saving accounts (widget-savings)
          if (widgetClass.includes('widget-savings')) {
            const nameEl = widget.querySelector('[data-qa-type="subtitle"] span');
            const balanceEl = widget.querySelector('[data-qa-type="title"] [data-sensitive="true"]');

            if (nameEl && balanceEl) {
              const name = nameEl.textContent.trim();
              const balanceText = balanceEl.textContent.trim();

              // Extract widget ID
              const widgetId = widgetClass.match(/widget-savings widget-(\d+)/)?.[1] ||
                              widgetClass.match(/widget-(\d+)/)?.[1] || 'unknown';

              // Parse balance (remove &nbsp; and convert to number)
              const balanceClean = balanceText.replace(/\u00A0/g, '').replace(/\s/g, '');
              const balanceValue = parseFloat(balanceClean.replace(/[^\d,]/g, '').replace(',', '.')) || 0;

              savings.push({
                id: widgetId,
                name: name,
                balance: balanceValue,
                balanceFormatted: balanceText,
                type: 'saving',
                currency: 'RUB'
              });
            }
          }
        });

        return savings;
      });

      console.log(`[TBANK] ✅ Found ${savingAccounts.length} saving accounts`);

      // Log each saving account
      savingAccounts.forEach(acc => {
        console.log(`[TBANK] ✅ [SAVING] ${acc.name}: ${acc.balanceFormatted} (ID: ${acc.id})`);
      });

      console.log('[TBANK] 📊 Saving account details:', JSON.stringify(savingAccounts, null, 2));

      return savingAccounts;

    } catch (error) {
      console.error('[TBANK] Error getting saving accounts:', error);
      throw error;
    }
  }

  /**
   * Create a new saving account (накопительный счёт)
   * Follows the path: /mybank/ -> "Новый счет или продукт" -> "Открыть накопительный счет" -> "Открыть счет"
   */
  async createSavingAccount() {
    try {
      if (!this.sessionActive) {
        throw new Error('Not logged in');
      }

      console.log('[TBANK] Creating new saving account...');

      // Ensure we're on /mybank/ page
      const currentUrl = this.page.url();
      if (!currentUrl.includes('/mybank/')) {
        console.log('[TBANK] Not on /mybank/ page, navigating...');
        await this.page.goto('https://www.tbank.ru/mybank/', {
          waitUntil: 'networkidle2',
          timeout: 30000
        });
      }

      // Wait for page to fully load
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Step 1: Click "Новый счет или продукт" button
      console.log('[TBANK] Step 1: Looking for "Новый счет или продукт" button...');

      // Find button by text content
      const newAccountButton = await this.page.evaluateHandle(() => {
        const buttons = Array.from(document.querySelectorAll('button'));
        return buttons.find(btn => btn.textContent.includes('Новый счет или продукт'));
      });

      if (!newAccountButton || newAccountButton.asElement() === null) {
        throw new Error('Could not find "Новый счет или продукт" button');
      }

      console.log('[TBANK] ✅ Found "Новый счет или продукт" button, clicking...');
      await newAccountButton.asElement().click();
      await new Promise(resolve => setTimeout(resolve, 2000 + Math.random() * 1000));

      // Step 2: Click "Открыть накопительный счет" link
      console.log('[TBANK] Step 2: Looking for "Открыть накопительный счет" link...');

      // Wait for the panel to appear and find the link
      await this.page.waitForSelector('a[href*="/deposit/create-saving/"]', {
        timeout: 10000
      });

      const savingAccountLink = await this.page.$('a[href*="/deposit/create-saving/"]');
      if (!savingAccountLink) {
        throw new Error('Could not find "Открыть накопительный счет" link');
      }

      console.log('[TBANK] ✅ Found "Открыть накопительный счет" link, clicking...');
      await savingAccountLink.click();

      // Wait for navigation
      await this.page.waitForNavigation({
        waitUntil: 'networkidle2',
        timeout: 15000
      }).catch(e => {
        console.log('[TBANK] Navigation timeout or no navigation needed:', e.message);
      });

      await new Promise(resolve => setTimeout(resolve, 2000));

      // Step 3: Click "Открыть счет" submit button
      console.log('[TBANK] Step 3: Looking for "Открыть счет" submit button...');

      // Find the submit button by data-qa-file and text
      const submitButton = await this.page.evaluateHandle(() => {
        const buttons = Array.from(document.querySelectorAll('button[data-qa-file="CreateSavingForm"]'));
        return buttons.find(btn => btn.textContent.includes('Открыть счет'));
      });

      if (!submitButton || submitButton.asElement() === null) {
        throw new Error('Could not find "Открыть счет" submit button');
      }

      console.log('[TBANK] ✅ Found "Открыть счет" button, clicking...');
      await submitButton.asElement().click();

      // Wait for account creation to complete
      await this.page.waitForNavigation({
        waitUntil: 'networkidle2',
        timeout: 15000
      }).catch(e => {
        console.log('[TBANK] Navigation timeout:', e.message);
      });

      await new Promise(resolve => setTimeout(resolve, 3000));

      // Verify we're back on /mybank/ or a success page
      const finalUrl = this.page.url();
      console.log('[TBANK] Final URL after creating saving account:', finalUrl);

      // Navigate back to /mybank/ if needed
      if (!finalUrl.includes('/mybank/')) {
        console.log('[TBANK] Navigating back to /mybank/...');
        await this.page.goto('https://www.tbank.ru/mybank/', {
          waitUntil: 'networkidle2',
          timeout: 30000
        });
        await new Promise(resolve => setTimeout(resolve, 3000));
      }

      // Fetch the newly created saving account
      console.log('[TBANK] Fetching newly created saving account...');
      const savingAccounts = await this.getSavingAccounts();

      if (savingAccounts.length === 0) {
        throw new Error('Saving account was not created or could not be found');
      }

      // Return the first saving account (newly created one)
      const newAccount = savingAccounts[0];
      console.log('[TBANK] ✅ Saving account created successfully!');
      console.log(`[TBANK] Account ID: ${newAccount.id}, Name: ${newAccount.name}`);

      return {
        success: true,
        account: newAccount
      };

    } catch (error) {
      console.error('[TBANK] Error creating saving account:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Transfer money from a debit account to saving account
   * @param {string} debitAccountName - Name of the debit account (e.g., "Совместный счет")
   * @param {string} savingAccountName - Name of the saving account (e.g., "Накопительный счет")
   * @param {number} amount - Amount to transfer
   */
  async transferToSavingAccount(debitAccountName, savingAccountName, amount) {
    try {
      if (!this.sessionActive) {
        throw new Error('Not logged in');
      }

      console.log(`[TBANK] 💸 Transferring ${amount} RUB from "${debitAccountName}" to "${savingAccountName}"...`);

      // Ensure we're on /mybank/ page
      const currentUrl = this.page.url();
      if (!currentUrl.includes('/mybank/')) {
        await this.page.goto('https://www.tbank.ru/mybank/', {
          waitUntil: 'networkidle2',
          timeout: 30000
        });
        await new Promise(resolve => setTimeout(resolve, 3000));
      }

      // Step 1: Open direct transfer page
      console.log('[TBANK] 1️⃣ Opening transfer page for between-account transfer...');
      const transferUrl = buildTransferBetweenAccountsUrl(requireEnv('TBANK_SOURCE_ACCOUNT_ID'));
      await this.page.goto(transferUrl, {
        waitUntil: 'networkidle2',
        timeout: 30000
      });
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Step 2: Select saving account in the dropdown
      console.log(`[TBANK] 2️⃣ Selecting saving account "${savingAccountName}"...`);

      // Find the selectAccount wrapper
      const selectSuccess = await this.page.evaluate((accountName) => {
        // Find all selectAccount wrappers
        const selects = Array.from(document.querySelectorAll('[data-qa-type="uikit/selectAccount.wrapper.main"]'));

        for (const select of selects) {
          // Click to open dropdown
          const labelContainer = select.querySelector('[data-style-layer="labelContainer"]');
          if (labelContainer) {
            labelContainer.click();

            // Wait a bit for dropdown to open
            setTimeout(() => {
              // Find the option with our saving account name
              const options = Array.from(document.querySelectorAll('[data-qa-type="uikit/selectAccount.wrapper.label"]'));
              const targetOption = options.find(opt => opt.textContent.trim() === accountName);

              if (targetOption) {
                // Click on the parent clickable element
                const clickable = targetOption.closest('[data-qa-type="uikit/clickable"]') ||
                                 targetOption.closest('a') ||
                                 targetOption.closest('button');
                if (clickable) {
                  clickable.click();
                  return true;
                }
              }
            }, 500);
          }
        }
        return false;
      }, savingAccountName);

      await new Promise(resolve => setTimeout(resolve, 2000));

      if (!selectSuccess) {
        console.log('[TBANK] ⚠️ Could not select saving account via dropdown');
      }

      // Step 3: Enter amount
      console.log(`[TBANK] 3️⃣ Entering amount ${amount}...`);

      await this.page.waitForSelector('input[data-qa-type="amount-from.input"]', {
        timeout: 10000
      });

      const amountInput = await this.page.$('input[data-qa-type="amount-from.input"]');
      if (!amountInput) {
        throw new Error('Could not find amount input field');
      }

      // Clear and enter amount
      await amountInput.click({ clickCount: 3 }); // Select all
      await this.page.keyboard.press('Backspace');
      await this.typeWithHumanDelay('input[data-qa-type="amount-from.input"]', amount.toString());
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Step 4: Click "Перевести" submit button
      console.log('[TBANK] 4️⃣ Submitting transfer...');

      const submitButton = await this.page.$('button[data-qa-type="submit-button"][type="submit"]');
      if (!submitButton) {
        throw new Error('Could not find "Перевести" submit button');
      }

      await submitButton.click();

      // Wait for transfer to complete
      await this.page.waitForNavigation({
        waitUntil: 'networkidle2',
        timeout: 15000
      }).catch(e => console.log('[TBANK] Navigation timeout:', e.message));
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Step 5: Navigate back to /mybank/
      const homeLink = await this.page.$('a[data-qa-type="desktop-ib-navigation-menu-link"][href="/mybank/"]');
      if (homeLink) {
        await homeLink.click();
        await this.page.waitForNavigation({
          waitUntil: 'networkidle2',
          timeout: 15000
        }).catch(e => console.log('[TBANK] Navigation timeout:', e.message));
      } else {
        // Fallback: navigate directly
        await this.page.goto('https://www.tbank.ru/mybank/', {
          waitUntil: 'networkidle2',
          timeout: 30000
        });
      }

      await new Promise(resolve => setTimeout(resolve, 3000));

      console.log(`[TBANK] ✅ Transfer completed: ${amount} RUB → "${savingAccountName}"`);

      return {
        success: true,
        message: `Transferred ${amount} RUB from "${debitAccountName}" to "${savingAccountName}"`,
        fromAccount: debitAccountName,
        toAccount: savingAccountName,
        amount: amount
      };

    } catch (error) {
      console.error('[TBANK] Error transferring to saving account:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Transfer money from saving account back to debit account
   * @param {string} savingAccountName - Name of the saving account
   * @param {string} debitAccountName - Name of the debit account
   * @param {number} amount - Amount to transfer
   */
  async transferFromSavingAccount(savingAccountName, debitAccountName, amount) {
    try {
      if (!this.sessionActive) {
        throw new Error('Not logged in');
      }

      console.log(`[TBANK] 💸 Transferring ${amount} RUB from "${savingAccountName}" back to "${debitAccountName}"...`);

      // Ensure we're on /mybank/ page
      const currentUrl = this.page.url();
      if (!currentUrl.includes('/mybank/')) {
        await this.page.goto('https://www.tbank.ru/mybank/', {
          waitUntil: 'networkidle2',
          timeout: 30000
        });
        await new Promise(resolve => setTimeout(resolve, 3000));
      }

      // Step 1: Click on the saving account widget
      console.log(`[TBANK] 1️⃣ Clicking saving account "${savingAccountName}"...`);

      const savingAccountWidget = await this.page.evaluateHandle((accountName) => {
        const widgets = Array.from(document.querySelectorAll('[data-qa-type^="atomPanel widget widget-savings"]'));
        return widgets.find(widget => {
          const nameEl = widget.querySelector('[data-qa-type="subtitle"] span');
          return nameEl && nameEl.textContent.trim() === accountName;
        });
      }, savingAccountName);

      if (!savingAccountWidget || savingAccountWidget.asElement() === null) {
        throw new Error(`Could not find saving account with name "${savingAccountName}"`);
      }

      const savingLink = await savingAccountWidget.asElement().$('a[data-qa-type="link click-area"]');
      if (!savingLink) {
        throw new Error('Could not find link in saving account widget');
      }

      await savingLink.click();
      await this.page.waitForNavigation({
        waitUntil: 'networkidle2',
        timeout: 15000
      }).catch(e => console.log('[TBANK] Navigation timeout:', e.message));
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Step 2: Click "Перевести" button
      console.log('[TBANK] 2️⃣ Clicking "Перевести" button...');

      const transferButton = await this.page.evaluateHandle(() => {
        const buttons = Array.from(document.querySelectorAll('button[data-qa-type*="transferButton"]'));
        return buttons.find(btn => btn.textContent.includes('Перевести'));
      });

      if (!transferButton || transferButton.asElement() === null) {
        throw new Error('Could not find "Перевести" button');
      }

      await transferButton.asElement().click();
      await new Promise(resolve => setTimeout(resolve, 2000 + Math.random() * 1000));

      // Step 3: Click "Между счетами" link
      console.log('[TBANK] 3️⃣ Clicking "Между счетами"...');

      const betweenAccountsLink = await this.page.evaluateHandle(() => {
        const links = Array.from(document.querySelectorAll('a[href*="transfer-between-accounts"]'));
        return links.find(link => link.textContent.includes('Между счетами'));
      });

      if (!betweenAccountsLink || betweenAccountsLink.asElement() === null) {
        throw new Error('Could not find "Между счетами" link');
      }

      await betweenAccountsLink.asElement().click();
      await this.page.waitForNavigation({
        waitUntil: 'networkidle2',
        timeout: 15000
      }).catch(e => console.log('[TBANK] Navigation timeout:', e.message));
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Step 4: Select debit account in the dropdown
      console.log(`[TBANK] 4️⃣ Selecting debit account "${debitAccountName}"...`);

      const selectSuccess = await this.page.evaluate((accountName) => {
        const selects = Array.from(document.querySelectorAll('[data-qa-type="uikit/selectAccount.wrapper.main"]'));

        for (const select of selects) {
          const labelContainer = select.querySelector('[data-style-layer="labelContainer"]');
          if (labelContainer) {
            labelContainer.click();

            setTimeout(() => {
              const options = Array.from(document.querySelectorAll('[data-qa-type="uikit/selectAccount.wrapper.label"]'));
              const targetOption = options.find(opt => opt.textContent.trim() === accountName);

              if (targetOption) {
                const clickable = targetOption.closest('[data-qa-type="uikit/clickable"]') ||
                                 targetOption.closest('a') ||
                                 targetOption.closest('button');
                if (clickable) {
                  clickable.click();
                  return true;
                }
              }
            }, 500);
          }
        }
        return false;
      }, debitAccountName);

      await new Promise(resolve => setTimeout(resolve, 2000));

      // Step 5: Enter amount
      console.log(`[TBANK] 5️⃣ Entering amount ${amount}...`);

      await this.page.waitForSelector('input[data-qa-type="amount-from.input"]', {
        timeout: 10000
      });

      const amountInput = await this.page.$('input[data-qa-type="amount-from.input"]');
      if (!amountInput) {
        throw new Error('Could not find amount input field');
      }

      await amountInput.click({ clickCount: 3 });
      await this.page.keyboard.press('Backspace');
      await this.typeWithHumanDelay('input[data-qa-type="amount-from.input"]', amount.toString());
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Step 6: Click "Перевести" submit button
      console.log('[TBANK] 6️⃣ Submitting transfer...');

      const submitButton = await this.page.$('button[data-qa-type="submit-button"][type="submit"]');
      if (!submitButton) {
        throw new Error('Could not find "Перевести" submit button');
      }

      await submitButton.click();

      await this.page.waitForNavigation({
        waitUntil: 'networkidle2',
        timeout: 15000
      }).catch(e => console.log('[TBANK] Navigation timeout:', e.message));
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Step 7: Navigate back to /mybank/
      const homeLink = await this.page.$('a[data-qa-type="desktop-ib-navigation-menu-link"][href="/mybank/"]');
      if (homeLink) {
        await homeLink.click();
        await this.page.waitForNavigation({
          waitUntil: 'networkidle2',
          timeout: 15000
        }).catch(e => console.log('[TBANK] Navigation timeout:', e.message));
      } else {
        await this.page.goto('https://www.tbank.ru/mybank/', {
          waitUntil: 'networkidle2',
          timeout: 30000
        });
      }

      await new Promise(resolve => setTimeout(resolve, 3000));

      console.log(`[TBANK] ✅ Transfer completed: ${amount} RUB → "${debitAccountName}"`);

      return {
        success: true,
        message: `Transferred ${amount} RUB from "${savingAccountName}" to "${debitAccountName}"`,
        fromAccount: savingAccountName,
        toAccount: debitAccountName,
        amount: amount
      };

    } catch (error) {
      console.error('[TBANK] Error transferring from saving account:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Execute forced transfer to saving account (для кнопки "Вечерний процент")
   * Transfers ALL available balance from all debit accounts to first saving account
   * Takes screenshots at each step for logging
   */
  async executeTransferToSaving(force = false) {
    try {
      if (!this.sessionActive) {
        throw new Error('Not logged in');
      }

      console.log('[TRANSFER] 🚀 === STARTING FORCED TRANSFER TO SAVING ===' );

      // Step 1: Take initial screenshot

      // Step 2: Get all debit accounts
      console.log('[TRANSFER] 📋 Fetching all debit accounts...');
      const debitAccounts = await this.getAccounts();

      if (debitAccounts.length === 0) {
        throw new Error('No debit accounts found');
      }

      console.log(`[TRANSFER] ✅ Found ${debitAccounts.length} debit accounts`);

      // Step 3: Get all saving accounts
      console.log('[TRANSFER] 📋 Fetching saving accounts...');
      const savingAccounts = await this.getSavingAccounts();

      if (savingAccounts.length === 0) {
        throw new Error('No saving accounts found - please create one first');
      }

      const targetSavingAccount = savingAccounts[0];
      console.log(`[TRANSFER] 🎯 Target saving account: "${targetSavingAccount.name}" (ID: ${targetSavingAccount.id})`);

      // Step 4: Transfer from each debit account
      const transfers = [];

      for (const debitAccount of debitAccounts) {
        if (debitAccount.balance > 0) {
          console.log(`[TRANSFER] 💸 Transferring ${debitAccount.balance} RUB from "${debitAccount.name}"...`);

          // Take screenshot before transfer

          const result = await this.transferToSavingAccount(
            debitAccount.name,
            targetSavingAccount.name,
            debitAccount.balance
          );

          // Take screenshot after transfer

          transfers.push({
            from: debitAccount.name,
            amount: debitAccount.balance,
            result: result
          });

          if (result.success) {
            console.log(`[TRANSFER] ✅ Successfully transferred ${debitAccount.balance} RUB from "${debitAccount.name}"`);
          } else {
            console.error(`[TRANSFER] ❌ Failed to transfer from "${debitAccount.name}":`, result.error);
          }
        } else {
          console.log(`[TRANSFER] ⏭️ Skipping "${debitAccount.name}" - balance is 0`);
        }
      }

      // Step 5: Take final screenshot

      console.log('[TRANSFER] 🎉 === FORCED TRANSFER COMPLETED ===');

      return {
        success: true,
        message: `Transferred funds from ${transfers.length} accounts to "${targetSavingAccount.name}"`,
        transfers: transfers,
        targetAccount: targetSavingAccount.name
      };

    } catch (error) {
      console.error('[TRANSFER] ❌ Error executing forced transfer:', error);

      // Take error screenshot

      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Transfer money via SBP (Faster Payment System) to another bank (e.g., Alfa-Bank)
   * Implements steps 2-8 from evening transfer instruction
   * @param {number} amount - Amount to transfer in RUB
   */
  async transferViaSBP(amount) {
    try {
      if (!this.sessionActive) {
        throw new Error('Not logged in');
      }

      const recipientPhone = requireEnv('FIXED_TBANK_PHONE');
      console.log(`[TBANK→SBP] 💸 Starting SBP transfer ${amount} RUB to phone ${recipientPhone}...`);

      // Ensure we're on /mybank/ page
      const currentUrl = this.page.url();
      if (!currentUrl.includes('/mybank/')) {
        await this.page.goto('https://www.tbank.ru/mybank/', {
          waitUntil: 'networkidle2',
          timeout: 30000
        });
        await new Promise(resolve => setTimeout(resolve, 3000));
      }

      // Step 2-4: Direct navigation to pre-filled transfer form
      console.log('[TBANK→SBP] Шаг 2-4/7: Переход по прямой ссылке на форму перевода...');

      const sbpAccountId = requireEnv('TBANK_SBP_ACCOUNT_ID');
      const transferUrl = buildSbpTransferUrl(sbpAccountId, recipientPhone);

      await this.page.goto(transferUrl, {
        waitUntil: 'networkidle2',
        timeout: 40000
      }).catch(e => console.log('[TBANK→SBP] Navigation timeout (продолжаем работу):', e.message));

      await new Promise(resolve => setTimeout(resolve, 2000));

      // Step 5: Get current account balance (from the selector on the page)
      console.log('[TBANK→SBP] Шаг 5/7: Получение баланса счёта...');

      const accountBalance = await this.page.evaluate(() => {
        const balanceElement = document.querySelector('span[data-qa-type="uikit/money"]');
        if (balanceElement) {
          return balanceElement.textContent;
        }
        return null;
      });

      if (!accountBalance) {
        throw new Error('Could not find account balance on the page');
      }

      // Parse balance: "13 774,62 ₽" -> 13774.62
      const normalizedBalance = accountBalance
        .replace(/\u00A0/g, ' ')
        .replace(/[^\d.,\s]/g, '')
        .trim();

      const balanceMatch = normalizedBalance.match(/[\d\s.,]+/);
      if (!balanceMatch) {
        throw new Error(`Could not parse balance: ${accountBalance}`);
      }

      const balanceCandidate = balanceMatch[0].replace(/\s/g, '');
      const lastComma = balanceCandidate.lastIndexOf(',');
      const lastDot = balanceCandidate.lastIndexOf('.');
      let decimalSeparator = null;

      if (lastComma !== -1 || lastDot !== -1) {
        decimalSeparator = lastComma > lastDot ? ',' : '.';
      }

      let balanceStr;
      if (decimalSeparator === ',') {
        balanceStr = balanceCandidate.replace(/\./g, '').replace(',', '.');
      } else if (decimalSeparator === '.') {
        balanceStr = balanceCandidate.replace(/,/g, '');
      } else {
        balanceStr = balanceCandidate.replace(/[^\d]/g, '');
      }

      const parsedBalance = parseFloat(balanceStr);

      if (Number.isNaN(parsedBalance)) {
        throw new Error(`Could not parse balance: ${accountBalance}`);
      }

      const transferAmountRaw = parsedBalance - MIN_TBANK_SBP_RESERVE_RUB;
      const normalizedTransferAmount = Math.max(
        0,
        Number(transferAmountRaw.toFixed(2))
      );

      console.log(
        `[TBANK→SBP] Баланс счёта: ${accountBalance} (~${parsedBalance} RUB) -> ` +
        `используем сумму: ${normalizedTransferAmount} RUB, резерв: ${MIN_TBANK_SBP_RESERVE_RUB} RUB`
      );

      if (normalizedTransferAmount <= 0) {
        console.log(
          `[TBANK→SBP] Баланс меньше или равен резерву ${MIN_TBANK_SBP_RESERVE_RUB} RUB, ` +
          'перевод отменён.'
        );

        await this.close();

        return {
          success: false,
          error: 'Недостаточно средств для перевода с учётом резерва 2000 RUB',
          errorCode: 'INSUFFICIENT_FUNDS',
          availableBalance: parsedBalance
        };
      }

      amount = normalizedTransferAmount;

      // Check for "Максимум запросов" error message
      const hasMaxRequestsError = await this.page.evaluate(() => {
        const errorDiv = document.querySelector('div[data-qa-type="molecule-desktop-whom-errorMessage"]');
        return errorDiv && errorDiv.textContent.includes('Максимум запросов в другие банки на сегодня');
      });

      if (hasMaxRequestsError) {
        console.log('[TBANK→SBP] ⚠️ Обнаружено сообщение "Максимум запросов в другие банки на сегодня"');

        // Step 5.1: Click "Другой банк"
        console.log('[TBANK→SBP] Шаг 5.1: Нажатие "Другой банк"...');

        const otherBankButton = await this.page.$('button[data-qa-type*="bank-plate-other-bank"]');
        if (!otherBankButton) {
          throw new Error('Could not find "Другой банк" button');
        }

        await otherBankButton.click();

        // Step 5.2: Wait 10 seconds and click "Альфа-Банк" in popup
        console.log('[TBANK→SBP] Шаг 5.2: Ожидание 10 секунд и нажатие "Альфа-Банк" в списке...');
        await new Promise(resolve => setTimeout(resolve, 10000));

        const alfaBankInPopup = await this.page.$('div[data-qa-type="banks-popup-item-title-100000000008"]');
        if (!alfaBankInPopup) {
          throw new Error('Could not find "Альфа-Банк" in banks popup');
        }

        await alfaBankInPopup.click();
        await new Promise(resolve => setTimeout(resolve, 2000));

      } else {
        // Step 6: Click "Альфа-Банк" button (standard flow)
        console.log('[TBANK→SBP] Шаг 6/7: Нажатие "Альфа-Банк"...');

        const alfaBankButton = await this.page.evaluateHandle(() => {
          const buttons = Array.from(document.querySelectorAll('button[data-qa-type*="bank-plate"]'));
          return buttons.find(btn => btn.textContent.includes('Альфа-Банк'));
        });

        if (!alfaBankButton || alfaBankButton.asElement() === null) {
          throw new Error('Could not find "Альфа-Банк" button');
        }

        await alfaBankButton.asElement().click();
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      // Step 7: Enter amount in the "Сумма" field
      console.log(`[TBANK→SBP] Шаг 7/7: Ввод суммы ${amount.toFixed(2)}...`);

      await this.page.waitForSelector('input[data-qa-type="amount-from.input"]', {
        timeout: 10000
      });

      const amountInput = await this.page.$('input[data-qa-type="amount-from.input"]');
      if (!amountInput) {
        throw new Error('Could not find amount input field');
      }

      // Clear and enter amount
      await amountInput.click({ clickCount: 3 }); // Select all
      await this.page.keyboard.press('Backspace');
      await this.typeWithHumanDelay('input[data-qa-type="amount-from.input"]', amount.toFixed(2));
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Step 8: Click "Перевести" submit button
      console.log('[TBANK→SBP] Шаг 8/7: Нажатие "Перевести" для подтверждения...');

      const submitButton = await this.page.$('button[data-qa-type="transfer-button"][type="submit"]');
      if (!submitButton) {
        throw new Error('Could not find submit "Перевести" button');
      }

      await submitButton.click();
      console.log('[TBANK→SBP] ⏳ Ожидание обработки перевода и проверка СМС-подтверждения...');

      // Poll for SMS confirmation prompt for up to 40 seconds
      const confirmationText = 'Мы отправили СМС с кодом на';
      let smsConfirmationRequired = false;
      const maxWaitTime = 40000; // 40 seconds
      const checkInterval = 2000; // Check every 2 seconds
      const smsStartTime = Date.now();

      while (Date.now() - smsStartTime < maxWaitTime) {
        await new Promise(resolve => setTimeout(resolve, checkInterval));

        const hasConfirmationText = await this.page.evaluate(text => {
          if (!document.body) return false;

          const elements = Array.from(document.body.querySelectorAll('*'));
          return elements.some(element => {
            if (!element.textContent || !element.textContent.includes(text)) {
              return false;
            }

            const style = window.getComputedStyle(element);
            if (!style || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
              return false;
            }

            const rect = element.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0;
          });
        }, confirmationText);

        if (hasConfirmationText) {
          smsConfirmationRequired = true;
          break;
        }

        const elapsedSeconds = Math.floor((Date.now() - smsStartTime) / 1000);
        console.log(`[TBANK→SBP] Проверка ${elapsedSeconds}с: текст СМС-подтверждения не найден, продолжаем ожидание...`);
      }

      if (smsConfirmationRequired) {
        console.log('[TBANK→SBP] ⚠️ Обнаружено требование СМС-подтверждения перевода');
        console.log('[TBANK→SBP] Ожидание СМС-кода для подтверждения перевода...');

        const smsCode = await this.waitForUserInput('sms');
        console.log(`[TBANK→SBP] Получен СМС-код: ${smsCode}, вводим через клавиатуру...`);

        for (const digit of smsCode) {
          await this.page.keyboard.type(digit);
          await new Promise(resolve => setTimeout(resolve, 100 + Math.random() * 100));
        }

        await new Promise(resolve => setTimeout(resolve, 2000));
        console.log('[TBANK→SBP] ✅ СМС-код введён');
      } else {
        console.log('[TBANK→SBP] СМС-подтверждение не потребовалось (текст подтверждения не появился)');
      }

      console.log('[TBANK→SBP] ✅ SBP transfer initiated successfully');

      // Additional wait to ensure completion
      const elapsedDuringSmsCheck = Date.now() - smsStartTime;
      const remainingWait = Math.max(0, 35000 - elapsedDuringSmsCheck);
      if (remainingWait > 0) {
        console.log(`[TBANK→SBP] ⏳ Дополнительное ожидание ${Math.floor(remainingWait / 1000)}с перед закрытием браузера...`);
        await new Promise(resolve => setTimeout(resolve, remainingWait));
      }

      return {
        success: true,
        amount
      };

    } catch (error) {
      console.error('[TBANK→SBP] ❌ Error:', error.message);

      // Take error screenshot
      await this.takeScreenshot('sbp-transfer-error');

      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Execute instruction steps 19-21 (инструкция шаги 21-23) after SBP перевод в Т-Банк
   * Шаг 19: Получить сумму на счёте (инструкция шаг 21)
   * Шаг 20: Ввести сумму в поле (инструкция шаг 22)
   * Шаг 21: Нажать "Перевести" (инструкция шаг 23)
   */
  async runMorningPostTransferFlow() {
    try {
      if (!this.sessionActive) {
        throw new Error('Not logged in');
      }

      console.log('[TBANK🌅] ▶️ Запуск шагов 19-21 для утреннего перевода...');

      // Шаг 1: Переход на страницу перевода между счетами
      console.log('[TBANK🌅] Переход на страницу перевода между счетами...');
      const transferPageUrl = buildTransferBetweenAccountsUrl(requireEnv('TBANK_SOURCE_ACCOUNT_ID'));

      try {
        await this.page.goto(transferPageUrl, {
          waitUntil: 'networkidle2',
          timeout: 30000
        });
        console.log('[TBANK🌅] ✅ Переход выполнен, ожидание загрузки страницы...');
      } catch (navError) {
        console.log('[TBANK🌅] ⚠️ Таймаут навигации (некритично), продолжаем выполнение...');
      }

      await new Promise(resolve => setTimeout(resolve, 3000));

      await this.takeScreenshot('morning-post-transfer-before');

      // Шаг 19: Получить сумму на счёте (шаг 21 инструкции)
      console.log('[TBANK🌅] 19/21: получаем сумму на счёте...');

      const accountAmount = await this.page.evaluate(() => {
        // Ищем элемент с суммой на счёте по data-qa-type="uikit/money"
        const moneyElement = document.querySelector('[data-qa-type="uikit/money"]');
        if (!moneyElement) return null;

        const text = moneyElement.textContent || '';
        // Убираем все пробелы и валюту, оставляем только цифры
        const cleanText = text.replace(/\s/g, '').replace(/₽/g, '').trim();
        return cleanText;
      });

      if (!accountAmount) {
        throw new Error('Не удалось получить сумму на счёте');
      }

      console.log(`[TBANK🌅] ✅ Сумма на счёте: ${accountAmount} ₽`);
      await new Promise(resolve => setTimeout(resolve, 1000));

      // Шаг 20: Ввести сумму в поле (шаг 22 инструкции)
      console.log(`[TBANK🌅] 20/21: вводим сумму ${accountAmount} в поле...`);

      // Wait for input field to appear
      await this.waitForSelectorWithRetry('[data-qa-type="amount-from.input"]', {
        timeout: 10000,
        retries: 3
      });

      // Click on input to focus
      await this.page.click('[data-qa-type="amount-from.input"]');
      await new Promise(resolve => setTimeout(resolve, 500));

      // Clear existing value first
      await this.page.evaluate(() => {
        const input = document.querySelector('[data-qa-type="amount-from.input"]');
        if (input) {
          input.value = '';
        }
      });

      // Type the amount using Puppeteer's type method (simulates real keyboard input)
      await this.page.type('[data-qa-type="amount-from.input"]', accountAmount, { delay: 50 });

      // Wait a bit and verify the value was entered
      await new Promise(resolve => setTimeout(resolve, 500));

      const valueEntered = await this.page.evaluate(() => {
        const input = document.querySelector('[data-qa-type="amount-from.input"]');
        return input ? input.value : null;
      });

      console.log(`[TBANK🌅] 📝 Проверка введённой суммы: "${valueEntered}"`);

      if (!valueEntered || valueEntered.trim() === '') {
        throw new Error('Не удалось ввести сумму в поле (поле пустое)');
      }

      console.log('[TBANK🌅] ✅ Сумма введена');
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Шаг 21: Нажать "Перевести" (шаг 23 инструкции)
      console.log('[TBANK🌅] 21/21: подтверждаем перевод...');

      let submitClicked = false;

      // Wait for submit button with retry
      try {
        await this.waitForSelectorWithRetry('[data-qa-type="submit-button.content"]', {
          timeout: 10000,
          retries: 3
        });

        submitClicked = await this.page.evaluate(() => {
          // Ищем кнопку по data-qa-type="submit-button.content"
          const buttonContent = document.querySelector('[data-qa-type="submit-button.content"]');
          if (!buttonContent) return false;

          // Находим родительскую кнопку
          const button = buttonContent.closest('button, [role="button"]');
          if (!button) return false;

          button.scrollIntoView({ behavior: 'instant', block: 'center', inline: 'center' });
          button.click();
          return true;
        });
      } catch (e) {
        console.log('[TBANK🌅] ⚠️ Селектор submit-button.content не найден после retry, пробуем по тексту...');
      }

      if (!submitClicked) {
        submitClicked = await this.clickElementByText('button, [role="button"]', 'Перевести', { timeout: 8000 });
      }

      if (!submitClicked) {
        throw new Error('Не удалось нажать кнопку "Перевести"');
      }

      console.log('[TBANK🌅] ⏳ Ожидание завершения операции перевода...');

      // Wait for navigation after clicking "Перевести"
      await this.page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {
        console.log('[TBANK🌅] ⚠️ Навигация не произошла или таймаут, продолжаем...');
      });

      // Additional wait to ensure the operation completes
      await new Promise(resolve => setTimeout(resolve, 5000));

      return {
        success: true,
      };
      
    } catch (error) {
      console.error('[TBANK🌅] ❌ Ошибка при выполнении шагов 19-21:', error.message);
      await this.takeScreenshot('morning-post-transfer-error');
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Transfer money between own accounts (old generic method - kept for backwards compatibility)
   */
  async transferBetweenAccounts(fromAccountId, toAccountId, amount) {
    try {
      if (!this.sessionActive) {
        throw new Error('Not logged in');
      }

      console.log(`[TBANK] Initiating transfer: ${amount} from ${fromAccountId} to ${toAccountId}`);

      // Navigate to transfers page
      await this.page.goto('https://www.tbank.ru/payments/', {
        waitUntil: 'networkidle2'
      });

      // Look for "Between my accounts" option
      const transferOption = await this.page.$('a[href*="transfer"], [data-qa*="transfer"]');
      if (transferOption) {
        await transferOption.click();
        await this.page.waitForNavigation({ waitUntil: 'networkidle2' });
      }

      // Select source account
      await this.page.waitForSelector('select[name="from"], [data-qa="from-account"]');
      await this.page.select('select[name="from"]', fromAccountId);

      // Select destination account
      await this.page.waitForSelector('select[name="to"], [data-qa="to-account"]');
      await this.page.select('select[name="to"]', toAccountId);

      // Enter amount
      await this.page.waitForSelector('input[name="amount"], [data-qa="amount"]');
      await this.page.type('input[name="amount"]', amount.toString(), { delay: 100 });

      // Submit transfer
      const submitButton = await this.page.$('button[type="submit"], [data-qa="submit"]');
      await submitButton.click();

      // Wait for confirmation
      await this.page.waitForSelector('[data-qa="success"], .success-message', {
        timeout: 10000
      });

      console.log('[TBANK] Transfer completed successfully');

      return {
        success: true,
        message: 'Transfer completed',
        fromAccountId,
        toAccountId,
        amount
      };

    } catch (error) {
      console.error('[TBANK] Transfer error:', error);
      return {
        success: false,
        error: error.message
      };
    }
  }

  /**
   * Close browser and cleanup
   * @param {boolean} deleteSession - Whether to delete saved session (default: false)
   */
  async close(deleteSession = false) {
    console.log(`[TBANK] Closing browser for user ${this.username}`);

    this.sessionActive = false;


    // Clear pending input resolvers to prevent memory leaks
    if (this.pendingInputResolve) {
      this.pendingInputResolve = null;
    }
    this.pendingInputType = null;
    this.pendingInputData = null;

    // If browser was reused from Alfa automation, don't close it
    if (this.reusingBrowser) {
      console.log('[TBANK] Browser was reused from Alfa automation, skipping close');
      this.browser = null;
      this.page = null;
      return;
    }

    // Close page first to free memory
    if (this.page) {
      try {
        // Remove all listeners
        await this.page.removeAllListeners();
        // Close page
        await this.page.close();
      } catch (e) {
        console.error('[TBANK] Error closing page:', e.message);
      }
      this.page = null;
    }

    // Close browser
    if (this.browser) {
      try {
        await this.browser.close();
      } catch (e) {
        console.error('[TBANK] Error closing browser:', e.message);
      }
      this.browser = null;
    }

    // DISK SPACE OPTIMIZATION: Removed userDataDir cleanup (no longer used)
    // Browser processes are cleaned up automatically by Puppeteer

    // Force garbage collection hint (if available)
    if (global.gc) {
      global.gc();
      console.log('[TBANK] Garbage collection triggered');
    }

    console.log('[TBANK] Browser and resources cleaned up');
  }

  /**
   * Get session statistics
   * @returns {Object} Session statistics
   */
  getSessionStats() {
    return {
      sessionActive: this.sessionActive
    };
  }
}
