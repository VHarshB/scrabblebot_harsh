import { DbConnection } from "./module_bindings/index.js";
const timer = setTimeout(() => {
  console.error("Public schema probe timed out");
  process.exit(1);
}, 20000);
DbConnection.builder()
  .withUri("https://maincloud.spacetimedb.com")
  .withDatabaseName("scrabblebot")
  .onConnect((conn) => {
    conn
      .subscriptionBuilder()
      .onError((_ctx) => {
        console.error("Subscription failed");
        process.exitCode = 1;
        clearTimeout(timer);
        conn.disconnect();
      })
      .onApplied(() => {
        console.log(
          JSON.stringify(
            {
              sdk: "2.12.x",
              connected: true,
              tournaments: [...conn.db.tournament.iter()].map((t) => ({
                id: String(t.id),
                status: t.status.tag,
              })),
              config: [...conn.db.matchmakerConfig.iter()],
            },
            (_, v) => (typeof v === "bigint" ? String(v) : v),
          ),
        );
        clearTimeout(timer);
        conn.disconnect();
      })
      .subscribe([
        "SELECT * FROM tournament",
        "SELECT * FROM matchmaker_config",
        "SELECT * FROM match_state",
        "SELECT * FROM my_rack",
        "SELECT * FROM bot_credential",
      ]);
  })
  .onConnectError((_ctx, err) => {
    console.error(err.message);
    clearTimeout(timer);
    process.exitCode = 1;
  })
  .build();
