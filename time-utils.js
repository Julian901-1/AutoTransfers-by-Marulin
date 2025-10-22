/**
 * Time utilities for T-Bank automation
 * Handles scheduling with random delays and timezone support
 */

import moment from 'moment-timezone';

/**
 * Convert user time (in user's timezone) to UTC
 * @param {string} timeString - Time in HH:MM format
 * @param {string} userTimezone - User timezone (e.g., "Europe/Moscow")
 * @returns {string} UTC time in HH:MM format
 */
export function convertUserTimeToUTC(timeString, userTimezone = 'Europe/Moscow') {
  if (!timeString || !/^\d{1,2}:\d{2}$/.test(timeString)) {
    throw new Error('Invalid time format. Expected HH:MM');
  }

  const [hours, minutes] = timeString.split(':').map(Number);

  // Create a moment object for today at the specified time in user's timezone
  const userTime = moment.tz({ hour: hours, minute: minutes }, userTimezone);

  // Convert to UTC
  const utcTime = userTime.utc();

  return `${String(utcTime.hours()).padStart(2, '0')}:${String(utcTime.minutes()).padStart(2, '0')}`;
}

/**
 * Convert UTC time to user's timezone
 * @param {string} timeString - Time in HH:MM format (UTC)
 * @param {string} userTimezone - User timezone (e.g., "Europe/Moscow")
 * @returns {string} User time in HH:MM format
 */
export function convertUTCToUserTime(timeString, userTimezone = 'Europe/Moscow') {
  if (!timeString || !/^\d{1,2}:\d{2}$/.test(timeString)) {
    throw new Error('Invalid time format. Expected HH:MM');
  }

  const [hours, minutes] = timeString.split(':').map(Number);

  // Create a moment object for today at the specified time in UTC
  const utcTime = moment.utc({ hour: hours, minute: minutes });

  // Convert to user timezone
  const userTime = utcTime.tz(userTimezone);

  return `${String(userTime.hours()).padStart(2, '0')}:${String(userTime.minutes()).padStart(2, '0')}`;
}

/**
 * Calculate next execution time based on target time (HH:MM) with random offset
 * @param {string} targetTime - Target time in HH:MM format in user's timezone (e.g., "14:30")
 * @param {number} minOffsetMinutes - Minimum random offset in minutes (default: 1)
 * @param {number} maxOffsetMinutes - Maximum random offset in minutes (default: 20)
 * @param {string} userTimezone - User timezone (default: "Europe/Moscow")
 * @returns {Date} Next execution date/time in UTC
 */
export function calculateNextExecutionTime(targetTime, minOffsetMinutes = 1, maxOffsetMinutes = 20, userTimezone = 'Europe/Moscow') {
  if (!targetTime || !/^\d{1,2}:\d{2}$/.test(targetTime)) {
    throw new Error('Invalid time format. Expected HH:MM');
  }

  if (minOffsetMinutes > maxOffsetMinutes) {
    throw new Error('minOffsetMinutes cannot be greater than maxOffsetMinutes');
  }

  const [hours, minutes] = targetTime.split(':').map(Number);

  if (hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    throw new Error('Invalid time values');
  }

  // Get current time in user's timezone
  const nowInUserTz = moment.tz(userTimezone);

  // Create target time for today in user's timezone
  const targetMoment = moment.tz(userTimezone).set({ hour: hours, minute: minutes, second: 0, millisecond: 0 });

  // If target time has already passed today, schedule for tomorrow
  if (targetMoment.isSameOrBefore(nowInUserTz)) {
    targetMoment.add(1, 'day');
  }

  // Add random offset (1-20 minutes by default)
  const randomOffset = getRandomIntInclusive(minOffsetMinutes, maxOffsetMinutes);
  targetMoment.add(randomOffset, 'minutes');

  // Return as JavaScript Date object (in UTC)
  return targetMoment.toDate();
}

/**
 * Check if it's time to execute based on target time and last execution
 * @param {string} targetTime - Target time in HH:MM format (in user's timezone)
 * @param {Date|null} lastExecution - Last execution timestamp (UTC)
 * @param {number} minOffsetMinutes - Minimum random offset in minutes
 * @param {number} maxOffsetMinutes - Maximum random offset in minutes
 * @param {string} userTimezone - User timezone (default: "Europe/Moscow")
 * @returns {boolean} True if it's time to execute
 */
export function shouldExecuteNow(targetTime, lastExecution = null, minOffsetMinutes = 1, maxOffsetMinutes = 20, userTimezone = 'Europe/Moscow') {
  if (!targetTime || !/^\d{1,2}:\d{2}$/.test(targetTime)) {
    throw new Error('Invalid time format. Expected HH:MM');
  }

  if (minOffsetMinutes > maxOffsetMinutes) {
    throw new Error('minOffsetMinutes cannot be greater than maxOffsetMinutes');
  }

  // Get current time in user's timezone
  const nowInUserTz = moment.tz(userTimezone);

  // Parse target time
  const [hours, minutes] = targetTime.split(':').map(Number);

  // Create target time for today in user's timezone
  const targetToday = moment.tz(userTimezone).set({ hour: hours, minute: minutes, second: 0, millisecond: 0 });

  // Add random offset to target time
  const offsetMinutes = getRandomIntInclusive(minOffsetMinutes, maxOffsetMinutes);
  const randomizedTarget = targetToday.add(offsetMinutes, 'minutes');

  // Convert last execution to user's timezone (if exists)
  const lastExecInUserTz = lastExecution ? moment(lastExecution).tz(userTimezone) : null;
  const alreadyExecutedToday = lastExecInUserTz ? lastExecInUserTz.isSame(nowInUserTz, 'day') : false;

  const shouldExecute = !alreadyExecutedToday && nowInUserTz.isSameOrAfter(randomizedTarget);

  return {
    shouldExecute,
    offsetMinutes,
    randomizedTarget: randomizedTarget.toDate(),
    alreadyExecutedToday,
    baseTime: targetTime
  };
}

/**
 * Format Date to HH:MM:SS string
 * @param {Date} date - Date object
 * @returns {string} Formatted time string
 */
export function formatTime(date) {
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');
  const seconds = String(date.getSeconds()).padStart(2, '0');
  return `${hours}:${minutes}:${seconds}`;
}

/**
 * Get time until next execution
 * @param {string} targetTime - Target time in HH:MM format (in user's timezone)
 * @param {number} minOffsetMinutes - Minimum random offset in minutes
 * @param {number} maxOffsetMinutes - Maximum random offset in minutes
 * @param {string} userTimezone - User timezone (default: "Europe/Moscow")
 * @returns {number} Milliseconds until next execution
 */
export function getTimeUntilNextExecution(targetTime, minOffsetMinutes = 1, maxOffsetMinutes = 20, userTimezone = 'Europe/Moscow') {
  const nextExecution = calculateNextExecutionTime(targetTime, minOffsetMinutes, maxOffsetMinutes, userTimezone);
  const now = new Date();
  return nextExecution.getTime() - now.getTime();
}

/**
 * Parse time string to hours and minutes
 * @param {string} timeString - Time in HH:MM format
 * @returns {{hours: number, minutes: number}}
 */
export function parseTime(timeString) {
  const [hours, minutes] = timeString.split(':').map(Number);
  return { hours, minutes };
}

/**
 * Check if current time is within a time range
 * @param {string} startTime - Start time in HH:MM format
 * @param {string} endTime - End time in HH:MM format
 * @returns {boolean} True if current time is within range
 */
export function isTimeInRange(startTime, endTime) {
  const now = new Date();
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  const start = parseTime(startTime);
  const startMinutes = start.hours * 60 + start.minutes;

  const end = parseTime(endTime);
  const endMinutes = end.hours * 60 + end.minutes;

  // Handle overnight ranges (e.g., 23:00 - 01:00)
  if (startMinutes > endMinutes) {
    return currentMinutes >= startMinutes || currentMinutes <= endMinutes;
  }

  return currentMinutes >= startMinutes && currentMinutes <= endMinutes;
}

/**
 * Generate random integer between min and max (inclusive)
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function getRandomIntInclusive(min, max) {
  const minInt = Math.ceil(min);
  const maxInt = Math.floor(max);
  return Math.floor(Math.random() * (maxInt - minInt + 1)) + minInt;
}
