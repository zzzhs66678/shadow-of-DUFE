export class DemoLibraryAdapter {
  constructor() {
    this.favorites = [
      { seatId: "LIB-3F-032", label: "三楼 032", area: "图书馆三楼" },
      { seatId: "LIB-4F-018", label: "四楼 018", area: "图书馆四楼" },
    ];
    this.availableSeats = new Set(["LIB-3F-032", "LIB-4F-018", "LIB-5F-006"]);
    this.currentReservation = null;
    this.executionCounts = { reserve: 0, cancel: 0 };
  }

  async getStatus() {
    return {
      connected: true,
      adapter: "demo",
      currentReservation: this.currentReservation,
    };
  }

  async listFavorites() {
    return this.favorites.map((seat) => ({ ...seat }));
  }

  async checkSeat({ seatId, seatKey, date }) {
    const effectiveSeatId = seatKey || seatId;
    return {
      seatId: effectiveSeatId,
      seatKey: effectiveSeatId,
      date,
      available: this.availableSeats.has(effectiveSeatId) && !this.currentReservation,
    };
  }

  async reserve({ seatId, seatKey, date, reservationKind }) {
    const effectiveSeatId = seatKey || seatId;
    this.executionCounts.reserve += 1;
    if (!this.availableSeats.has(effectiveSeatId)) {
      throw new Error("所选座位当前不可预约");
    }
    if (this.currentReservation) {
      throw new Error("当前已有预约");
    }

    this.currentReservation = {
      reservationId: `demo-${date}-${effectiveSeatId}`,
      seatId: effectiveSeatId,
      seatKey: effectiveSeatId,
      date,
      reservationKind,
    };
    return { ...this.currentReservation };
  }

  async cancel({ reservationId }) {
    this.executionCounts.cancel += 1;
    if (!this.currentReservation || this.currentReservation.reservationId !== reservationId) {
      throw new Error("未找到要取消的预约");
    }

    const cancelled = this.currentReservation;
    this.currentReservation = null;
    return {
      reservationId: cancelled.reservationId,
      seatId: cancelled.seatId,
      date: cancelled.date,
      cancelled: true,
    };
  }
}
