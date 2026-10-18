    def exchange_handoff(self, ticket):
        if not isinstance(ticket, str) or not re.fullmatch(r"[A-Za-z0-9_-]{43}", ticket):
            raise ControlError("连接凭证已失效，请重新连接", 401)
        with self.lock, self.connect() as db:
            db.execute("BEGIN IMMEDIATE")
            row = db.execute("SELECT token FROM handoffs WHERE token=? AND expires>?", (self.digest(ticket), time.time())).fetchone()
            if row is None:
                raise ControlError("连接凭证已失效，请重新连接", 401)
            db.execute("DELETE FROM handoffs WHERE token=?", (self.digest(ticket),))
            token, csrf = secrets.token_urlsafe(32), secrets.token_urlsafe(32)
            db.execute("DELETE FROM sessions WHERE expires<=?", (time.time(),))
            db.execute("DELETE FROM sessions WHERE token IN (SELECT token FROM sessions ORDER BY expires DESC LIMIT -1 OFFSET 20)")
            db.execute("INSERT INTO sessions VALUES (?,?,?)", (self.digest(token), csrf, time.time() + SESSION_SECONDS))
            return token, csrf

