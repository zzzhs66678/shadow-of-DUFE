const query = (operationName, source, variables = undefined) => ({
  operationName,
  query: source,
  ...(variables === undefined ? {} : { variables }),
});

export const TRACEINT_PROTOCOL = Object.freeze({
  cookieEndpoint: "https://wechat.v2.traceint.com/index.php/urlNew/auth.html",
  authorizationReturnUrl: "https://web.traceint.com/web/index.html",
  graphQlEndpoint: "https://wechat.v2.traceint.com/index.php/graphql/",
  defaultProfile: {
    origin: "https://web.traceint.com",
    referer: "https://web.traceint.com/web/index.html",
    appVersion: "2.0.11",
  },
  tomorrowProfile: {
    origin: "https://web.traceint.com",
    referer: "https://web.traceint.com/",
    appVersion: "2.2.5",
  },
});

export function listLibrariesOperation() {
  return query(
    "list",
    `query list {
      userAuth {
        reserve {
          libs(libType: -1) {
            lib_id lib_floor is_open lib_name lib_type lib_group_id lib_comment
            lib_rt { seats_total seats_used seats_booking seats_has reserve_ttl open_time open_time_str close_time close_time_str advance_booking }
          }
        }
      }
    }`,
  );
}

export function libraryLayoutOperation(libraryId) {
  return query(
    "libLayout",
    `query libLayout($libId: Int, $libType: Int) {
      userAuth {
        reserve {
          libs(libType: $libType, libId: $libId) {
            lib_id is_open lib_floor lib_name lib_type
            lib_layout {
              seats_total seats_booking seats_used max_x max_y
              seats { x y key type name seat_status status }
            }
          }
        }
      }
    }`,
    { libId: Number(libraryId) },
  );
}

export function reservationInfoOperation() {
  return query(
    "index",
    `query index($pos: String!, $param: [hash]) {
      userAuth {
        reserve {
          reserve {
            token status lib_id lib_name lib_floor seat_key seat_name date exp_date exp_date_str
          }
          getSToken
        }
      }
    }`,
    { pos: "App-首页" },
  );
}

export function reserveSeatOperation(libraryId, seatKey) {
  return query(
    "reserueSeat",
    `mutation reserueSeat($libId: Int!, $seatKey: String!, $captchaCode: String, $captcha: String!) {
      userAuth {
        reserve {
          reserueSeat(libId: $libId, seatKey: $seatKey, captchaCode: $captchaCode, captcha: $captcha)
        }
      }
    }`,
    {
      libId: Number(libraryId),
      seatKey: String(seatKey),
      captchaCode: "",
      captcha: "",
    },
  );
}

export function cancelReservationOperation(reservationToken) {
  return query(
    "reserveCancle",
    `mutation reserveCancle($sToken: String!) {
      userAuth {
        reserve {
          reserveCancle(sToken: $sToken) { timerange img hours mins per }
        }
      }
    }`,
    { sToken: String(reservationToken) },
  );
}

export function tomorrowWarmUpOperation(libraryId) {
  return query(
    "libLayout",
    `query libLayout($libId: Int!) {
      userAuth {
        prereserve {
          libLayout(libId: $libId) { seats_booking seats_total seats_used }
        }
      }
    }`,
    { libId: Number(libraryId) },
  );
}

export function tomorrowReserveOperation(libraryId, seatKey) {
  return query(
    "save",
    `mutation save($key: String!, $libid: Int!, $captchaCode: String, $captcha: String) {
      userAuth {
        prereserve {
          save(key: $key, libId: $libid, captcha: $captcha, captchaCode: $captchaCode)
        }
      }
    }`,
    {
      key: `${String(seatKey).replace(/\.+$/, "")}.`,
      libid: Number(libraryId),
      captchaCode: "",
      captcha: "",
    },
  );
}

export function tomorrowReservationInfoOperation() {
  return query(
    "prereserve",
    `query prereserve {
      userAuth {
        prereserve {
          prereserve { day lib_id seat_key seat_name is_used }
        }
      }
    }`,
    {},
  );
}
