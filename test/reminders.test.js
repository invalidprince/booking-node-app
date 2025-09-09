const assert = require('assert');
process.env.NODE_ENV = 'test';
const server = require('..');

describe('checkAndSendReminders', () => {
  let emails;
  beforeEach(() => {
    emails = [];
    server.bookings.length = 0;
    server.remindedBookings.clear();
    server.sendBookingReminderEmail = async (...args) => {
      emails.push(args);
    };
  });

  it('sends reminder for weekly recurring booking', async () => {
    const now = new Date();
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().slice(0, 10);
    const weekday = tomorrow.getDay();
    server.bookings.push({
      id: 'w1',
      name: 'Weekly',
      email: 'w@example.com',
      spaceId: 'space',
      date: '2020-01-01',
      startTime: '10:00',
      endTime: '11:00',
      recurring: { frequency: 'weekly', weekday }
    });

    await server.checkAndSendReminders();

    assert.strictEqual(emails.length, 1);
    assert.ok(server.remindedBookings.has(`w1|${tomorrowStr}`));
  });

  it('sends reminder for monthly recurring booking', async () => {
    const now = new Date();
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().slice(0, 10);
    const dayOfMonth = tomorrow.getDate();
    server.bookings.push({
      id: 'm1',
      name: 'Monthly',
      email: 'm@example.com',
      spaceId: 'space',
      date: '2020-01-01',
      startTime: '10:00',
      endTime: '11:00',
      recurring: { dayOfMonth }
    });

    await server.checkAndSendReminders();

    assert.strictEqual(emails.length, 1);
    assert.ok(server.remindedBookings.has(`m1|${tomorrowStr}`));
  });

  it('avoids duplicate reminders for same occurrence', async () => {
    const now = new Date();
    const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
    const tomorrowStr = tomorrow.toISOString().slice(0, 10);
    const weekday = tomorrow.getDay();
    server.bookings.push({
      id: 'd1',
      name: 'Dup',
      email: 'd@example.com',
      spaceId: 'space',
      date: '2020-01-01',
      startTime: '10:00',
      endTime: '11:00',
      recurring: { frequency: 'weekly', weekday }
    });

    await server.checkAndSendReminders();
    await server.checkAndSendReminders();

    assert.strictEqual(emails.length, 1);
    assert.ok(server.remindedBookings.has(`d1|${tomorrowStr}`));
  });
});
