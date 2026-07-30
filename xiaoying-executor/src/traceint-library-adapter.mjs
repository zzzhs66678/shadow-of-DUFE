import { TraceIntError } from "./traceint-client.mjs";

export class TraceIntLibraryAdapter {
  constructor({
    client,
    credentialProvider,
    connectionStateProvider = () => ({ status: "connected" }),
    onSessionExpired = () => {},
    favoritesProvider = async () => [],
  }) {
    this.client = client;
    this.credentialProvider = credentialProvider;
    this.connectionStateProvider = connectionStateProvider;
    this.onSessionExpired = onSessionExpired;
    this.favoritesProvider = favoritesProvider;
  }

  async getStatus() {
    const connection = this.connectionStateProvider();
    if (connection.status !== "connected") {
      return {
        connected: false,
        adapter: "traceint",
        connection,
        currentReservation: null,
      };
    }
    const reservation = await this.#withSession((cookie) =>
      this.client.getCurrentReservation(cookie),
    );
    return {
      connected: true,
      adapter: "traceint",
      connection,
      currentReservation: reservation
        ? {
            ...reservation,
            reservationId: reservation.reservationToken,
          }
        : null,
    };
  }

  async listFavorites() {
    return this.favoritesProvider();
  }

  async listLibraries() {
    return this.#withSession((cookie) => this.client.listLibraries(cookie));
  }

  async getLibraryLayout(libraryId) {
    return this.#withSession((cookie) =>
      this.client.getLibraryLayout(cookie, libraryId),
    );
  }

  async checkSeat({ libraryId, seatKey, seatId, date }) {
    const effectiveSeatKey = seatKey || seatId;
    const layout = await this.getLibraryLayout(libraryId);
    const seat = layout.seats.find((candidate) => candidate.seatKey === effectiveSeatKey);
    return {
      libraryId: layout.libraryId,
      libraryName: layout.name,
      seatId: effectiveSeatKey,
      seatKey: effectiveSeatKey,
      seatName: seat?.seatName ?? effectiveSeatKey,
      date,
      available: Boolean(seat?.isAvailable && layout.isOpen),
    };
  }

  async reserve({ libraryId, seatKey, seatId, date, reservationKind }) {
    const effectiveSeatKey = seatKey || seatId;
    const succeeded =
      reservationKind === "tomorrow"
        ? await this.#withSession((cookie) =>
            this.client.reserveTomorrow(cookie, { libraryId, seatKey: effectiveSeatKey }),
          )
        : await this.#withSession((cookie) =>
            this.client.reserveSeat(cookie, { libraryId, seatKey: effectiveSeatKey }),
          );
    if (succeeded === false) throw new Error("图书馆没有确认预约成功");

    const reservation =
      reservationKind === "tomorrow"
        ? succeeded
        : await this.#withSession((cookie) =>
            this.client.getCurrentReservation(cookie),
          );
    return {
      reservationId:
        reservation?.reservationToken ??
        `tomorrow-${date}-${libraryId}-${effectiveSeatKey}`,
      libraryId: Number(libraryId),
      seatId: effectiveSeatKey,
      seatKey: effectiveSeatKey,
      seatName: reservation?.seatName ?? effectiveSeatKey,
      date: reservation?.date ?? reservation?.day ?? date,
      reservationKind,
    };
  }

  async cancel({ reservationId, reservationToken }) {
    const token = reservationToken || reservationId;
    const cancelled = await this.#withSession((cookie) =>
      this.client.cancelReservation(cookie, token),
    );
    if (!cancelled) throw new Error("图书馆没有确认取消成功");
    return {
      reservationId: token,
      cancelled: true,
    };
  }

  async #withSession(operation) {
    const credential = await this.credentialProvider();
    if (!credential) throw new Error("请先连接我去图书馆");
    try {
      return await operation(credential);
    } catch (error) {
      if (error instanceof TraceIntError && error.code === "SESSION_EXPIRED") {
        await this.onSessionExpired(error);
      }
      throw error;
    }
  }
}
