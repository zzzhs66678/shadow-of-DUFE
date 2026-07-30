export class SeatWatchRunner {
  constructor({ store, adapterForUser, clock = () => Date.now() }) {
    this.store = store;
    this.adapterForUser = adapterForUser;
    this.clock = clock;
    this.timer = null;
    this.running = false;
  }

  start() {
    if (this.timer) return;
    this.timer = setInterval(() => this.runDue().catch(() => {}), 60_000);
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
      for (const watch of this.store.listDueSeatWatches(20)) {
        const preferences = this.store.getUserPreferences(watch.userId);
        try {
          const adapter = this.adapterForUser(watch.userId);
          const status =
            watch.seatKey === "*"
              ? await adapter.getLibraryLayout(watch.libraryId).then((layout) => ({
                  available: layout.availableSeats > 0,
                  availableSeats: layout.availableSeats,
                }))
              : await adapter.checkSeat({
                  libraryId: watch.libraryId,
                  seatKey: watch.seatKey,
                  date: new Date(this.clock()).toISOString().slice(0, 10),
                });
          this.store.finishSeatWatchCheck(watch.id, {
            available: status.available,
            intervalMinutes: preferences.monitorIntervalMinutes,
          });
          if (status.available) {
            this.store.createNotification(watch.userId, {
              kind: "seat_available",
              title:
                watch.seatKey === "*"
                  ? `${watch.libraryName} 有空位了`
                  : `${watch.seatLabel} 空出来了`,
              body:
                watch.seatKey === "*"
                  ? `目前约有 ${status.availableSeats} 个座位可选，请打开东财之影确认。`
                  : `${watch.libraryName || "图书馆"}现在可以预约，请打开东财之影确认。`,
              actionUrl: "/#library",
              deduplicationKey: `seat-available:${watch.id}:${new Date(this.clock()).toISOString().slice(0, 10)}`,
            });
          }
        } catch (error) {
          this.store.finishSeatWatchCheck(watch.id, {
            available: false,
            errorCode: error?.code || "CHECK_FAILED",
            intervalMinutes: preferences.monitorIntervalMinutes,
          });
        }
      }
    } finally {
      this.running = false;
    }
  }
}
