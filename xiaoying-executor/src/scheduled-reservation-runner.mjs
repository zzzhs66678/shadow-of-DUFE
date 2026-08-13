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
      for (const action of this.store.recoverExpiredScheduledReservationLeases()) {
        this.store.createNotification(action.userId, {
          kind: "scheduled_reservation_review_required",
          title: `${action.seatLabel} 的预约状态需要确认`,
          body: "服务曾在执行时中断。为避免重复预约，小影没有自动重试，请先查看当前预约。",
          actionUrl: "/#library",
          deduplicationKey: `scheduled-reservation-review-required:${action.id}`,
        });
      }
      for (const action of this.store.listDueScheduledReservations(10)) {
        const leaseToken = this.store.claimScheduledReservation(action.id);
        if (!leaseToken) continue;
        try {
          const adapter = this.adapterForUser(action.userId);
          await adapter.reserve({
            libraryId: action.libraryId,
            seatKey: action.seatKey,
            date: new Date(action.runAt).toISOString().slice(0, 10),
            reservationKind: action.reservationKind,
          });
          const finished = this.store.finishScheduledReservation(action.id, {
            succeeded: true,
            leaseToken,
          });
          if (!finished) continue;
          this.store.createNotification(action.userId, {
            kind: "reservation_succeeded",
            title: `${action.seatLabel} 预约成功`,
            body: `${action.libraryName} · ${action.reservationKind === "tomorrow" ? "明日预约" : "今日预约"}`,
            actionUrl: "/#overview",
            deduplicationKey: `scheduled-reservation-succeeded:${action.id}`,
          });
        } catch (error) {
          const finalAttempt = action.attemptCount + 1 >= action.maxAttempts;
          const finished = this.store.finishScheduledReservation(action.id, {
            succeeded: false,
            errorCode: error?.code || "RESERVATION_FAILED",
            leaseToken,
          });
          if (finished && finalAttempt) {
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
