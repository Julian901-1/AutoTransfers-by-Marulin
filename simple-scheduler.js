import moment from 'moment-timezone';

const DEFAULT_TIMEZONE = 'Europe/Moscow';

function getRandomIntInclusive(min, max) {
  const minInt = Math.ceil(min);
  const maxInt = Math.floor(max);
  return Math.floor(Math.random() * (maxInt - minInt + 1)) + minInt;
}

function parseHour(value) {
  if (value === null || value === undefined) {
    return null;
  }

  if (typeof value === 'number' && isFinite(value)) {
    const hour = Math.floor(value) % 24;
    return hour >= 0 ? hour : null;
  }

  const str = String(value).trim();
  if (!str) {
    return null;
  }

  const match = str.match(/^(\d{1,2})(?::(\d{1,2}))?/);
  if (!match) {
    return null;
  }

  const hour = parseInt(match[1], 10);
  if (isNaN(hour) || hour < 0 || hour > 23) {
    return null;
  }

  return hour;
}

export class SimpleScheduler {
  constructor({
    username,
    baseUrl,
    eveningHour = null,
    morningHour = null,
    timezone = DEFAULT_TIMEZONE,
    eveningOffsetRange = [-20, 20],
    morningOffsetRange = [-20, 20]
  }) {
    this.username = username;
    this.baseUrl = baseUrl;
    this.timezone = moment.tz.zone(timezone) ? timezone : DEFAULT_TIMEZONE;
    this.eveningHour = parseHour(eveningHour);
    this.morningHour = parseHour(morningHour);
    this.eveningOffsetRange = eveningOffsetRange;
    this.morningOffsetRange = morningOffsetRange;

    this.events = {
      evening: { timeout: null, baseHour: this.eveningHour, nextRun: null },
      morning: { timeout: null, baseHour: this.morningHour, nextRun: null }
    };

    this.started = false;
  }

  async start() {
    if (this.started) {
      return;
    }

    this.started = true;

    if (!this.username || !this.baseUrl) {
      console.warn('[SIMPLE-SCHEDULER] Missing username or base URL. Scheduler not started.');
      return;
    }

    console.log(
      `[SIMPLE-SCHEDULER] Starting for user ${this.username} (base ${this.baseUrl}, timezone ${this.timezone})`
    );

    if (this.eveningHour === null) {
      console.log('[SIMPLE-SCHEDULER] Evening transfer disabled: SCHEDULER_EVENING_HOUR not set or invalid');
    } else {
      this.scheduleTransfer('evening', this.eveningHour);
    }

    if (this.morningHour === null) {
      console.log('[SIMPLE-SCHEDULER] Morning transfer disabled: SCHEDULER_MORNING_HOUR not set or invalid');
    } else {
      this.scheduleTransfer('morning', this.morningHour);
    }
  }

  stop() {
    Object.values(this.events).forEach(event => {
      if (event.timeout) {
        clearTimeout(event.timeout);
        event.timeout = null;
      }
    });

    this.started = false;
    console.log('[SIMPLE-SCHEDULER] Stopped');
  }

  scheduleTransfer(eventName, baseHour) {
    const [minOffset, maxOffset] =
      eventName === 'evening' ? this.eveningOffsetRange : this.morningOffsetRange;

    const { nextRun, offset } = this.calculateNextRun(baseHour, this.timezone, minOffset, maxOffset);
    const delay = Math.max(nextRun.getTime() - Date.now(), 0);

    const event = this.events[eventName];
    event.baseHour = baseHour;
    event.nextRun = nextRun;

    console.log(
      `[SIMPLE-SCHEDULER] Next ${eventName} transfer at ${nextRun.toISOString()} ` +
        `(hour ${String(baseHour).padStart(2, '0')}:00, offset ${offset} min, timezone ${this.timezone})`
    );

    event.timeout = setTimeout(async () => {
      await this.triggerTransfer(eventName);
      this.scheduleTransfer(eventName, baseHour);
    }, delay);
  }

  delayEvent(eventName, days = 1) {
    const event = this.events[eventName];
    if (!event || event.baseHour === null || !event.nextRun) {
      return false;
    }

    if (event.timeout) {
      clearTimeout(event.timeout);
      event.timeout = null;
    }

    const newNextRun = new Date(event.nextRun.getTime() + days * 24 * 60 * 60 * 1000);
    const delay = Math.max(newNextRun.getTime() - Date.now(), 0);

    event.nextRun = newNextRun;

    console.log(
      `[SIMPLE-SCHEDULER] Delayed ${eventName} transfer by ${days} day(s); new run at ${newNextRun.toISOString()}`
    );

    event.timeout = setTimeout(async () => {
      await this.triggerTransfer(eventName);
      this.scheduleTransfer(eventName, event.baseHour);
    }, delay);

    return true;
  }

  calculateNextRun(baseHour, timezone, minOffset, maxOffset) {
    const tz = timezone || DEFAULT_TIMEZONE;

    let target = moment.tz({ hour: baseHour, minute: 0, second: 0, millisecond: 0 }, tz);
    const now = moment.tz(tz);

    if (target.isSameOrBefore(now)) {
      target = target.add(1, 'day');
    }

    const offset = getRandomIntInclusive(minOffset, maxOffset);
    target = target.add(offset, 'minutes');

    return {
      nextRun: target.toDate(),
      offset
    };
  }

  async triggerTransfer(eventName) {
    const endpoint =
      eventName === 'evening' ? '/api/evening-transfer' : '/api/morning-transfer';
    const url = `${this.baseUrl}${endpoint}`;

    console.log(`[SIMPLE-SCHEDULER] Triggering ${eventName} transfer via ${url}`);

    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({ username: this.username })
      });

      const result = await response.json().catch(() => ({}));

      if (!response.ok || result.success === false) {
        throw new Error(result.error || response.statusText || 'Unknown error');
      }

      console.log(`[SIMPLE-SCHEDULER] ${eventName} transfer completed successfully`);
    } catch (error) {
      console.error(`[SIMPLE-SCHEDULER] ${eventName} transfer failed:`, error.message || error);
    }
  }
}
