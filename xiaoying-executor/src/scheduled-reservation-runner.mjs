export class ScheduledReservationRunner {
  constructor({ store, adapterForUser }) {
    this.store = store;
    this.adapterForUser = adapterForUser;
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.runDue().catch(() => {}), 1_000);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runDue() {
    if (this.running) return;
    this.running = true;
    try {
      for (const action of this.store.listDueScheduledReservations(10)) {
        if (!this.store.claimScheduledReservation(action.id)) continue;
        try {
          const adapter = this.adapterForUser(action.userId);
          await adapter.reserve({
            libraryId: action.libraryId,
            seatKey: action.seatKey,
            date: new Date(action.runAt).toISOString().slice(0, 10),
            reservationKind: action.reservationKind,
          });
          this.store.finishScheduledReservation(action.id, { succeeded: true });
          this.store.createNotification(action.userId, {
            kind: "reservation_succeeded",
            title: `${action.seatLabel} 预约成功`,
            body: `${action.libraryName} · ${action.reservationKind === "tomorrow" ? "明日预约" : "今日预约"}`,
            actionUrl: "/#overview",
            deduplicationKey: `scheduled-reservation-succeeded:${action.id}`,
          });
        } catch (error) {
          const finalAttempt = action.attemptCount + 1 >= action.maxAttempts;
          this.store.finishScheduledReservation(action.id, {
            succeeded: false,
            errorCode: error?.code || "RESERVATION_FAILED",
          });
          if (finalAttempt) {
            this.store.createNotification(action.userId, {
              kind: "reservation_failed",
              title: `${action.seatLabel} 没有预约成功`,
              body: "已达到你设置的尝试次数，可以换个座位再试。",
              actionUrl: "/#library",
              deduplicationKey: `scheduled-reservation-failed:${action.id}`,
            });
          }
        }
      }
    } finally {
      this.running = false;
    }
  }
}
