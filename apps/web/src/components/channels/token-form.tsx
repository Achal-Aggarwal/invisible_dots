"use client";

import { accountLabel } from "@invisible-dots/shared/browser";
import { useState, type FormEvent } from "react";
import { toast } from "sonner";
import { api } from "../../lib/api";
import { ErrorAlert } from "../ErrorAlert";
import { Field } from "../new-dot/Field";
import { useAction } from "../ui";
import { Button } from "../ui/button";
import { Input } from "../ui/input";

/**
 * Where the Telegram bot's token is pasted. It goes to the control plane, which checks it with Telegram and stores it
 * encrypted; it is never shown again, so the field is emptied the moment it is sent and nothing on the page can
 * read it back. A token for a channel that already exists replaces the old one (the people paired stay).
 */
export function TokenForm({ dotId, relink, onSaved }: { dotId: string; relink: boolean; onSaved: () => void }) {
  const [token, setToken] = useState("");
  const [empty, setEmpty] = useState(false);
  const save = useAction();

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (token.trim() === "") {
      setEmpty(true);
      return;
    }
    setEmpty(false);
    let account: string | null = null;
    const ok = await save.run(async () => {
      account = (await api.putTelegramChannel(dotId, token)).account;
    });
    if (!ok) return;
    setToken("");
    toast.success(`Telegram is connected${accountLabel("telegram", account) ? ` as ${accountLabel("telegram", account)}` : ""}.`);
    onSaved();
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="space-y-3" noValidate>
      <Field
        id="telegram-token"
        label={relink ? "New bot token" : "Bot token"}
        hint={
          <>
            From <a href="https://t.me/BotFather" target="_blank" rel="noreferrer" className="underline underline-offset-4">@BotFather</a>: send it /newbot, or /token for a bot you have. It is checked with Telegram, kept encrypted on this machine and never shown again.
          </>
        }
        error={empty ? "Paste the bot's token." : null}
      >
        {(control) => <Input {...control} type="password" value={token} autoComplete="off" spellCheck={false} placeholder="123456:ABC-DEF..." onChange={(event) => setToken(event.target.value)} />}
      </Field>
      <ErrorAlert error={save.error} title={relink ? "The token was not changed" : "Telegram was not connected"} />
      <Button type="submit" size="sm" disabled={save.pending}>
        {save.pending ? "Checking with Telegram..." : relink ? "Use this token" : "Connect Telegram"}
      </Button>
    </form>
  );
}
