/**
 * Discord process, unattended: every 10 minutes the upkeep keeps the booster role, #boosters and the feature rooms as
 * designed; every minute the notifier (once Orrery's contracts are configured) posts release drafts, burns and alerts;
 * every six hours linked wallets' roles are re-checked. Before launch, with no contract addresses yet, it runs the upkeep
 * only. Needs ORRERY_DISCORD_TOKEN_FILE, ORRERY_DISCORD_GUILD and ORRERY_DATABASE_URL; never logs the token.
 */
import { boostProgress, channelIds, connect, discordRest, ensureBoosters, ensureBoosterTiers, ensureRoleOrder, welcomeNewMembers, loadConfig, loadDiscordConfig, makeChain, migrate, notifyOnce, syncFeatureRooms, syncRoles, type Config } from "../index.js";

const d = loadDiscordConfig();
if (!d) throw new Error("Set ORRERY_DISCORD_TOKEN_FILE and ORRERY_DISCORD_GUILD to run the Discord process.");
let cfg: Config | null = null;
try {
  cfg = loadConfig();
} catch (e) {
  console.log(JSON.stringify({ at: new Date().toISOString(), mode: "upkeep only", reason: e instanceof Error ? e.message.split("\n")[0] : String(e) }));
}
const sql = connect(cfg?.databaseUrl ?? process.env.ORRERY_DATABASE_URL ?? "postgres://orrery:orrery@127.0.0.1:55432/orrery");
await migrate(sql);
const chain = cfg ? makeChain(cfg) : null;
const api = discordRest(d);
const everyMs = Number(process.env.ORRERY_DISCORD_EVERY_MS ?? 60_000);
const upkeepEveryMs = Number(process.env.ORRERY_DISCORD_UPKEEP_EVERY_MS ?? 10 * 60_000);
const syncEveryMs = Number(process.env.ORRERY_DISCORD_SYNC_EVERY_MS ?? 6 * 3600_000);
let channels = await channelIds(api);
let lastUpkeep = 0;
let lastSync = 0;
const err = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0] : String(e));

for (;;) {
  const at = new Date().toISOString();
  // Test mode (development network): the production process owns the upkeep and the welcomes.
  if (!d.testChannel && Date.now() - lastUpkeep >= upkeepEveryMs) {
    try {
      const changed = [
        ...(await ensureBoosters(api, d.guildId)),
        ...(await ensureBoosterTiers(api, d.guildId)),
        ...(await boostProgress(sql, api, d.guildId)),
        ...(await syncFeatureRooms(sql, api, d.guildId)),
        ...(await ensureRoleOrder(api, d.guildId)),
      ];
      if (changed.length) console.log(JSON.stringify({ at, upkeep: changed }));
      lastUpkeep = Date.now();
    } catch (e) {
      console.error(JSON.stringify({ at, upkeepError: err(e) }));
    }
  }
  // welcomes run every minute, before launch too
  if (!d.testChannel) {
    try {
      const welcomed = await welcomeNewMembers(sql, api, d.guildId);
      if (welcomed.length) console.log(JSON.stringify({ at, welcome: welcomed }));
    } catch (e) {
      console.error(JSON.stringify({ at, welcomeError: err(e) }));
    }
  }
  if (cfg && chain) {
    try {
      const posted = await notifyOnce(cfg, chain, sql, d, api, channels);
      if (posted.length) console.log(JSON.stringify({ at, posted }));
    } catch (e) {
      console.error(JSON.stringify({ at, error: err(e) }));
      channels = await channelIds(api).catch(() => channels);
    }
    if (Date.now() - lastSync >= syncEveryMs) {
      try {
        console.log(JSON.stringify({ at, rolesChecked: await syncRoles(cfg, chain, sql, api, !!d.testChannel) }));
        lastSync = Date.now();
      } catch (e) {
        console.error(JSON.stringify({ at, syncError: err(e) }));
      }
    }
  }
  await new Promise((res) => setTimeout(res, everyMs));
}
