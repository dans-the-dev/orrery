"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { erc20Abi, type Abi, type Address } from "viem";
import { useReadContract } from "wagmi";
import { BOOST_KINDS, iOrryPriceOracleAbi, orryBoostAbi, orryChatAbi, orryNamesAbi, type CommunityMessage, type CommunityRoom } from "@orrery/shared";
import { WalletButton } from "@/components/WalletButton";
import { AmountField, NoticeLine, OrryHead, Row, TxLink } from "@/components/orry/parts";
import { activeChain } from "@/lib/config";
import { useMessages, useRooms } from "@/lib/community/api";
import { useCommunity, type CommunityConfig } from "@/lib/community/config";
import { bpsOf, excerpt, isZeroAddr, percent, sameAddr, usd, utf8Bytes, validName, withHeadroom } from "@/lib/community/logic";
import { useCommunityTx, type Run } from "@/lib/community/tx";
import { big, time } from "@/lib/orry/api";
import { useAccountChain, useNow, useWallet } from "@/lib/orry/chain";
import { COMING_SOON } from "@/lib/orry/config";
import { ago, mask, parseAmount, orry, span, toInput } from "@/lib/orry/format";

const chatAbi = orryChatAbi as Abi;
const namesAbi = orryNamesAbi as Abi;
const boostAbi = orryBoostAbi as Abi;

/** ORRY in the connected wallet, from the token the community config names. */
function useOrryBalance(token: Address | null, address?: Address) {
  return useReadContract({ address: token ?? undefined, abi: erc20Abi, functionName: "balanceOf", args: address ? [address] : undefined, query: { enabled: Boolean(token && address), refetchInterval: 12_000 } }).data;
}

export function ChatView() {
  const { config, live } = useCommunity();
  if (!config) return null;
  return <Chat cfg={config} boostOpen={live("burn-to-boost")} />;
}

function Chat({ cfg, boostOpen }: { cfg: CommunityConfig; boostOpen: boolean }) {
  const rooms = useRooms(true);
  const [roomId, setRoomId] = useState(0);
  const [replyTo, setReplyTo] = useState<CommunityMessage | null>(null);
  const list = rooms.data?.rooms ?? [];
  const room = list.find((r) => r.id === roomId);

  return (
    <>
      <OrryHead
        title="Talk with Orrery holders, on chain."
        lead={
          <p>
            Every message is a transaction on {activeChain.name}. A post costs {usd(cfg.postFeeUsd)} in ORRY, paid to the Reward Pool that funds the community&apos;s rewards.
          </p>
        }
        reading={<NameCard cfg={cfg} />}
      />
      <div className="cm-chat">
        <aside className="cm-rooms" aria-label="Rooms">
          <h2>Rooms</h2>
          {rooms.isLoading ? (
            <p className="rc-muted">…</p>
          ) : list.length === 0 ? (
            <p className="rc-muted">Rooms appear here in a moment.</p>
          ) : (
            <ul>
              {list.map((r) => (
                <li key={r.id}>
                  <button
                    type="button"
                    aria-pressed={r.id === roomId}
                    onClick={() => {
                      setRoomId(r.id);
                      setReplyTo(null);
                    }}
                  >
                    <strong>{r.name}</strong>
                    <span>{big(r.minStakeUsd) > 0n ? `Stakers with ${usd(big(r.minStakeUsd))} or more` : "Open to everyone"}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </aside>
        <section className="cm-feed" aria-label="Messages">
          <Composer key={roomId} cfg={cfg} room={room} roomId={roomId} replyTo={replyTo} onReplyDone={() => setReplyTo(null)} />
          <Feed cfg={cfg} roomId={roomId} boostOpen={boostOpen} onReply={setReplyTo} />
        </section>
      </div>
    </>
  );
}

/** Username: set or change it, paid in ORRY to the Reward Pool. */
function NameCard({ cfg }: { cfg: CommunityConfig }) {
  const { address, ready, connected } = useWallet();
  const tx = useCommunityTx();
  const names = cfg.addresses.names;
  const oracle = cfg.addresses.priceOracle;
  const [input, setInput] = useState("");
  const current = useReadContract({ address: names ?? undefined, abi: orryNamesAbi, functionName: "nameOf", args: address ? [address] : undefined, query: { enabled: Boolean(names && address) } });
  const valid = validName(input);
  const holder = useReadContract({ address: names ?? undefined, abi: orryNamesAbi, functionName: "ownerOf", args: [input], query: { enabled: Boolean(names && valid) } });
  const fee = useReadContract({ address: oracle ?? undefined, abi: iOrryPriceOracleAbi, functionName: "orryFor", args: [cfg.nameFeeUsd], query: { enabled: Boolean(oracle), refetchInterval: 30_000 } });
  const mine = current.data || "";
  const taken = valid && holder.data && !isZeroAddr(holder.data) && !sameAddr(holder.data, address);
  const own = valid && sameAddr(holder.data, address);

  async function setName() {
    if (!address || !names || !cfg.addresses.orry || fee.data === undefined || !valid) return;
    const max = withHeadroom(fee.data);
    const name = input;
    await tx.run("Set name", async ({ send, step, approve }) => {
      await approve(cfg.addresses.orry as Address, names, max);
      step("Confirm the name in your wallet.");
      await send({ address: names, abi: namesAbi, functionName: "setName", args: [name, max] });
      setInput("");
      return `Your name is now ${name}.`;
    });
  }

  return (
    <div className="rc-card cm-name">
      <p className="rc-card-title">
        Your name
        {mine ? <span>{mine}</span> : null}
      </p>
      {!names || !oracle ? (
        <p className="rc-card-wait">Usernames: {COMING_SOON}.</p>
      ) : !connected ? (
        <>
          <p className="rc-card-wait">Pick a username others see beside your messages.</p>
          <WalletButton />
        </>
      ) : (
        <>
          <div className="rc-amount">
            <label htmlFor="cm-name-in">{mine ? "New name" : "Username"}</label>
            <div className="rc-amount-box">
              <input id="cm-name-in" autoComplete="off" spellCheck={false} placeholder="your_name" maxLength={20} value={input} onChange={(e) => setInput(e.target.value.toLowerCase().replace(/[^a-z0-9_]/g, ""))} />
            </div>
            <div className="rc-amount-foot">
              <span>{taken ? "That name belongs to another wallet." : own ? "That is already your name." : "3 to 20 characters: a to z, 0 to 9 and underscore."}</span>
            </div>
          </div>
          <dl className="rc-rows rc-rows-tight">
            <Row label="Fee" hint={`${usd(cfg.nameFeeUsd)}, paid to the Reward Pool`}>
              {fee.data !== undefined ? `${orry(fee.data)} ORRY` : "…"}
            </Row>
          </dl>
          <button className="primary rc-go" type="button" disabled={!ready || Boolean(tx.busy) || !valid || Boolean(taken) || own || fee.data === undefined} onClick={() => void setName()}>
            {tx.busy ? "Setting…" : mine ? "Change name" : "Set name"}
          </button>
          <NoticeLine notice={tx.notice} />
        </>
      )}
    </div>
  );
}

/** Post box: text up to the room's byte limit, the live fee in ORRY, and the reply it answers. */
function Composer({ cfg, room, roomId, replyTo, onReplyDone }: { cfg: CommunityConfig; room?: CommunityRoom; roomId: number; replyTo: CommunityMessage | null; onReplyDone: () => void }) {
  const { address, ready, connected } = useWallet();
  const tx = useCommunityTx();
  const chat = cfg.addresses.chat as Address;
  const [text, setText] = useState("");
  const bytes = utf8Bytes(text);
  const over = bytes > cfg.maxTextBytes;
  const fee = useReadContract({ address: chat, abi: orryChatAbi, functionName: "postFee", query: { refetchInterval: 30_000 } });
  const minStake = room ? big(room.minStakeUsd) : 0n;
  const stake = useReadContract({ address: chat, abi: orryChatAbi, functionName: "stakeUsdOf", args: address ? [address] : undefined, query: { enabled: Boolean(address && minStake > 0n), refetchInterval: 30_000 } });
  const below = minStake > 0n && stake.data !== undefined && stake.data < minStake;

  async function post() {
    if (!address || fee.data === undefined || !text.trim() || over) return;
    const max = withHeadroom(fee.data);
    const reply = replyTo ? BigInt(replyTo.id) : 0n;
    await tx.run("Post", async ({ send, step, approve }) => {
      await approve(cfg.addresses.orry as Address, chat, max);
      step("Confirm the post in your wallet.");
      await send({ address: chat, abi: chatAbi, functionName: "post", args: [BigInt(roomId), reply, text, max] });
      setText("");
      onReplyDone();
      return "Posted. It appears in the room in a moment.";
    });
  }

  return (
    <div className="rc-desk cm-compose">
      {replyTo ? (
        <p className="cm-replying">
          <span>
            Replying to <strong>{replyTo.authorName ?? mask(replyTo.author)}</strong>
            {replyTo.text ? `: ${excerpt(replyTo.text)}` : ""}
          </span>
          <button type="button" className="cm-link" onClick={onReplyDone}>
            Cancel
          </button>
        </p>
      ) : null}
      <label className="cm-label" htmlFor="cm-text">
        {room ? `Message ${room.name}` : "Message"}
      </label>
      <textarea id="cm-text" rows={3} value={text} onChange={(e) => setText(e.target.value)} placeholder="Write a message" disabled={below} />
      <div className="cm-compose-foot">
        <span className={over ? "cm-bytes is-over" : "cm-bytes"} aria-live="polite">
          {bytes.toLocaleString("en-US")} / {cfg.maxTextBytes.toLocaleString("en-US")} bytes
        </span>
        <span className="cm-fee">
          Fee {fee.data !== undefined ? <strong>{orry(fee.data)} ORRY</strong> : null} ({usd(cfg.postFeeUsd)})
        </span>
      </div>
      {below ? (
        <p className="rc-desk-note">
          Posting here needs {usd(minStake)} or more earning in Stake. Yours is {usd(stake.data ?? 0n)}. <Link className="cm-link" href="/stake">Stake ORRY</Link>
        </p>
      ) : null}
      {connected ? (
        <button className="primary rc-go" type="button" disabled={!ready || Boolean(tx.busy) || !text.trim() || over || below || fee.data === undefined} onClick={() => void post()}>
          {tx.busy ? "Posting…" : replyTo ? "Post reply" : "Post"}
        </button>
      ) : (
        <div className="rc-connect">
          <p>Connect a wallet to post.</p>
          <WalletButton />
        </div>
      )}
      <NoticeLine notice={tx.notice} />
    </div>
  );
}

/** The room's messages, newest first, with reply, tip, report and boost. */
function Feed({ cfg, roomId, boostOpen, onReply }: { cfg: CommunityConfig; roomId: number; boostOpen: boolean; onReply: (m: CommunityMessage) => void }) {
  const { address, ready } = useWallet();
  const q = useMessages(roomId, true);
  const tx = useCommunityTx();
  const now = useNow(5000);
  const me = useAccountChain(address);
  const [tipping, setTipping] = useState<string | null>(null);
  const [actedOn, setActedOn] = useState<string | null>(null);
  const boost = cfg.addresses.boost;
  const boostQuote = useReadContract({ address: boost ?? undefined, abi: orryBoostAbi, functionName: "quote", args: [BOOST_KINDS.post, 1n], query: { enabled: Boolean(boost && boostOpen), refetchInterval: 30_000 } });
  const canReport = me.earning !== undefined && cfg.reportMinStake > 0n && me.earning >= cfg.reportMinStake;

  const messages = useMemo(() => {
    const seen = new Set<string>();
    return (q.data?.pages ?? []).flatMap((p) => p.messages).filter((m) => (seen.has(m.id) ? false : (seen.add(m.id), true)));
  }, [q.data]);
  const byId = useMemo(() => new Map(messages.map((m) => [m.id, m])), [messages]);

  async function report(m: CommunityMessage) {
    setActedOn(m.id);
    await tx.run("Report", async ({ send }) => {
      await send({ address: cfg.addresses.chat as Address, abi: chatAbi, functionName: "report", args: [BigInt(m.id)] });
      return "Reported. The message hides once enough stakers report it.";
    });
  }

  async function boostPost(m: CommunityMessage) {
    if (!boost || boostQuote.data === undefined) return;
    const max = withHeadroom(boostQuote.data);
    setActedOn(m.id);
    await tx.run("Boost", async ({ send, step, approve }) => {
      await approve(cfg.addresses.orry as Address, boost, max);
      step("Confirm the boost in your wallet.");
      await send({ address: boost, abi: boostAbi, functionName: "boost", args: [BOOST_KINDS.post, BigInt(m.id), 1n, max] });
      return "Boosted for 24 hours. The ORRY paid is burned.";
    });
  }

  if (q.isLoading) return <p className="rc-muted">…</p>;
  if (messages.length === 0) return <p className="rc-muted cm-empty">{q.isError ? "Messages appear here in a moment." : "No messages in this room yet. The first post opens it."}</p>;

  return (
    <div className="cm-msgs">
      <ol>
        {messages.map((m) => {
          const hidden = m.hidden || m.text === null;
          const own = sameAddr(m.author, address);
          const boostedUntil = m.boostedUntil ? time(m.boostedUntil) : 0;
          const parent = m.replyTo && m.replyTo !== "0" ? byId.get(m.replyTo) : undefined;
          const tips = big(m.tips);
          return (
            <li key={m.id} className={boostedUntil > now ? "cm-msg is-boosted" : "cm-msg"}>
              <div className="cm-msg-head">
                <strong>{m.authorName ?? mask(m.author)}</strong>
                {own ? <span className="cm-you">you</span> : null}
                <span className="cm-time">{ago(time(m.time), now)}</span>
                {boostedUntil > now ? <span className="cm-boosted">Boosted, {span(boostedUntil - now)} left</span> : null}
                <TxLink hash={m.txHash} />
              </div>
              {m.replyTo && m.replyTo !== "0" ? (
                <p className="cm-quote">
                  Reply to {parent ? <strong>{parent.authorName ?? mask(parent.author)}</strong> : `message ${m.replyTo}`}
                  {parent?.text && !parent.hidden ? `: ${excerpt(parent.text, 70)}` : ""}
                </p>
              ) : null}
              {hidden ? <p className="cm-hidden">This message is hidden.</p> : <p className="cm-text">{m.text}</p>}
              {tips > 0n ? <p className="cm-tips">{orry(tips)} ORRY in tips</p> : null}
              {!hidden && ready ? (
                <div className="cm-actions">
                  <button type="button" className="cm-link" onClick={() => onReply(m)}>
                    Reply
                  </button>
                  {own ? null : (
                    <button type="button" className="cm-link" aria-expanded={tipping === m.id} onClick={() => setTipping(tipping === m.id ? null : m.id)}>
                      Tip
                    </button>
                  )}
                  {boostOpen && boost ? (
                    <button type="button" className="cm-link" disabled={Boolean(tx.busy) || boostQuote.data === undefined} onClick={() => void boostPost(m)} title={boostQuote.data !== undefined ? `${orry(boostQuote.data)} ORRY, burned` : undefined}>
                      Boost 24 h{boostQuote.data !== undefined ? ` · ${orry(boostQuote.data)} ORRY` : ""}
                    </button>
                  ) : null}
                  {canReport && !own ? (
                    <button type="button" className="cm-link cm-quiet" disabled={Boolean(tx.busy)} onClick={() => void report(m)}>
                      Report
                    </button>
                  ) : null}
                </div>
              ) : null}
              {tipping === m.id ? <TipForm cfg={cfg} message={m} run={tx.run} busy={Boolean(tx.busy)} onStart={() => setActedOn(m.id)} onDone={() => setTipping(null)} /> : null}
              {actedOn === m.id ? <NoticeLine notice={tx.notice} /> : null}
            </li>
          );
        })}
      </ol>
      {q.hasNextPage ? (
        <button type="button" className="secondary cm-more" disabled={q.isFetchingNextPage} onClick={() => void q.fetchNextPage()}>
          {q.isFetchingNextPage ? "Loading…" : "Earlier messages"}
        </button>
      ) : null}
    </div>
  );
}

/** Tip in ORRY: the author receives the amount minus the cut, which goes to the Reward Pool. */
function TipForm({ cfg, message, run, busy, onStart, onDone }: { cfg: CommunityConfig; message: CommunityMessage; run: Run; busy: boolean; onStart: () => void; onDone: () => void }) {
  const { address, ready } = useWallet();
  const balance = useOrryBalance(cfg.addresses.orry, address);
  const [input, setInput] = useState("");
  const amount = parseAmount(input);
  const cut = amount ? bpsOf(amount, cfg.tipCutBps) : undefined;
  const author = message.authorName ?? mask(message.author);
  const chat = cfg.addresses.chat as Address;

  async function tip() {
    if (!amount) return;
    onStart();
    const ok = await run("Tip", async ({ send, step, approve }) => {
      await approve(cfg.addresses.orry as Address, chat, amount);
      step("Confirm the tip in your wallet.");
      await send({ address: chat, abi: chatAbi, functionName: "tip", args: [BigInt(message.id), amount] });
      return `Sent ${orry(amount)} ORRY to ${author}.`;
    });
    if (ok) onDone();
  }

  return (
    <div className="cm-tip">
      <AmountField
        id={`cm-tip-${message.id}`}
        label={`Tip ${author}`}
        unit="ORRY"
        value={input}
        onChange={setInput}
        max={balance !== undefined ? orry(balance) : undefined}
        onMax={() => balance !== undefined && setInput(toInput(balance))}
        hint={
          amount && cut !== undefined
            ? `${orry(amount - cut)} ORRY to ${author}, ${orry(cut)} ORRY (${percent(cfg.tipCutBps)}) to the Reward Pool.`
            : `${percent(cfg.tipCutBps)} of each tip goes to the Reward Pool.`
        }
      />
      <button className="primary" type="button" disabled={!ready || busy || !amount || (balance !== undefined && amount > balance)} onClick={() => void tip()}>
        {busy ? "Sending…" : "Send tip"}
      </button>
    </div>
  );
}
