function wait(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export class ReservationGuardRunner {
  constructor({ store, adapterForUser, clock = () => Date.now(), waitFor = wait }) {
    this.store = store;
    this.adapterForUser = adapterForUser;
    this.clock = clock;
    this.waitFor = waitFor;
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.runDue().catch(() => {}), 5_000);
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
      for (const guard of this.store.listDueReservationGuards(10)) {
        if (!this.store.claimReservationGuard(guard.id)) continue;
        try {
          const adapter = this.adapterForUser(guard.userId);
          const status = await adapter.getStatus();
          const reservation = status.currentReservation;
          if (!reservation) {
            this.store.finishReservationGuardCheck(guard.id, {
              status: "paused",
              errorCode: "NO_ACTIVE_RESERVATION",
            });
            this.store.createNotification(guard.userId, {
              kind: "reservation_guard_paused",
              title: "预约守护已暂停",
              body: "没有找到当前预约，重新预约后可以再次开启。",
              actionUrl: "/#library",
              deduplicationKey: `reservation-guard-no-reservation:${guard.id}`,
            });
            continue;
          }

          const expiresAt = Date.parse(reservation.expiresAt ?? "");
          if (!Number.isFinite(expiresAt)) {
            this.store.finishReservationGuardCheck(guard.id, {
              status: "active",
              delayMs: 60_000,
              errorCode: "EXPIRATION_UNKNOWN",
            });
            continue;
          }

          const remainingMs = expiresAt - this.clock();
          if (remainingMs > guard.rebookBeforeSeconds * 1_000) {
            this.store.finishReservationGuardCheck(guard.id, {
              status: "active",
              delayMs: Math.max(
                10_000,
                Math.min(60_000, remainingMs - guard.rebookBeforeSeconds * 1_000),
              ),
            });
            continue;
          }

          await adapter.cancel({
            reservationId: reservation.reservationToken ?? reservation.reservationId,
          });
          await this.waitFor(guard.rebookDelaySeconds * 1_000);
          await adapter.reserve({
            libraryId: reservation.libraryId,
            seatKey: reservation.seatKey,
            date: reservation.date || new Date(this.clock()).toISOString().slice(0, 10),
            reservationKind: "normal",
          });

          const completed = guard.cycleCount + 1 >= guard.maxCycles;
          this.store.finishReservationGuardCheck(guard.id, {
            status: completed ? "completed" : "active",
            delayMs: 60_000,
            incrementCycle: true,
          });
          this.store.createNotification(guard.userId, {
            kind: "reservation_guard_succeeded",
            title: `${reservation.seatName || reservation.seatKey} 已重新预约`,
            body: completed ? "已达到你设置的守护次数，任务已结束。" : "预约守护仍在继续。",
            actionUrl: "/#overview",
            deduplicationKey: `reservation-guard-cycle:${guard.id}:${guard.cycleCount + 1}`,
          });
        } catch (error) {
          this.store.finishReservationGuardCheck(guard.id, {
            status: "paused",
            errorCode: error?.code || "REBOOK_FAILED",
          });
          this.store.createNotification(guard.userId, {
            kind: "reservation_guard_failed",
            title: "预约守护没有完成",
            body: "座位可能已经释放，请立即打开“我去图书馆”确认状态。",
            actionUrl: "/#library",
            deduplicationKey: `reservation-guard-failed:${guard.id}`,
          });
        }
      }
    } finally {
      this.running = false;
    }
  }
}
