# Relay cost model (P4-S3)

Recorded 2026-11-14 for the quota relay on `relay.the40thieves.dev`. The test
`workers/relay/tests/quota-route.test.ts` ("a simulated day") checks a day against this budget, with
the prices in `workers/relay/tests/cost-model.ts`.

## Budget

**$5.00 a month for the whole `relay` Worker: the Workers Paid base, with no overage.** The quota
relay must fit inside what the plan already includes.

## Prices used (Workers Paid, list prices on 2026-11-14)

| Item                          | Included a month | Over that       |
| ----------------------------- | ---------------- | --------------- |
| Base plan                     | n/a              | $5.00 a month   |
| Worker requests               | 10,000,000       | $0.30 a million |
| Durable Object requests       | 1,000,000        | $0.15 a million |
| Analytics Engine data points  | 10,000,000       | $0.25 a million |
| Durable Object SQLite storage | 5 GB             | not reached     |

Sources: [Workers pricing](https://developers.cloudflare.com/workers/platform/pricing/),
[Durable Objects pricing](https://developers.cloudflare.com/durable-objects/platform/pricing/),
[Analytics Engine pricing](https://developers.cloudflare.com/analytics/analytics-engine/pricing/).
Re-check them when this file is next touched.

## What one quota request costs

One `/v1/quota/<source>` request is one Worker request. If it passes the session and rate-limit
checks, it also writes one Analytics Engine data point, and if it gets as far as the budget check,
it is one Durable Object request too. Requests refused before the data point (origin, method,
source, target, key, session, rate limit) cost the Worker request alone; a `dns_blocked` refusal
costs the Worker request and one data point, but no Durable Object request.
Each counter holds at most one row for the site and one per visitor per source per day. Old days
are deleted on the next request, so storage stays a few kilobytes.

## Caps

The site spends 80% of each upstream's declared daily cap (`SITE_SHARE` in
`workers/relay/src/quota.ts`, caps from `data/sources.json`). A visitor gets a small fixed share.

| Source        | Upstream cap a day | Site cap a day | Visitor cap a day |
| ------------- | ------------------ | -------------- | ----------------- |
| courtlistener | 125                | 100            | 10                |
| guardian      | 450                | 360            | 30                |
| ucdp          | 4,500              | 3,600          | 100               |
| **Total**     | 5,075              | **4,060**      |                   |

At most 4,060 requests a day reach an upstream, whatever the load. Upstream keys are free, so the
relayed requests cost nothing upstream.

## Break-even

The binding limit is the 1,000,000 Durable Object requests included a month: about **33,000 quota
requests a day** reach the budget check before any overage. Past that, each extra million costs
$0.15. Each IP is held to 60 relay requests a minute by the rate limiter before the budget check.

The table counts quota requests only. `/v1/fetch`, `/v1/session`, healthz and every other request
to the Worker draw on the same 10,000,000 included Worker requests (the Durable Object and
Analytics Engine allowances are the quota relay's alone), so the Worker-request headroom left for
the quota relay is 10,000,000 a month less that other traffic. Read the account's Workers usage
next to the dashboard query below before relying on the break-even.

| Load (quota requests only)                     | Quota requests a month | Monthly cost |
| ---------------------------------------------- | ---------------------- | ------------ |
| At cap, every request relayed (4,060 a day)    | 121,800                | $5.00        |
| Simulated day in the test (15,000 a day)       | 450,000                | $5.00        |
| Break-even (about 33,000 a day)                | 1,000,000              | $5.00        |
| Abuse at 100,000 a day, all reaching the check | 3,000,000              | $5.30        |

For reference, THE-1281's sync-relay spike (Durable Objects plus R2, a different shape of load)
put that relay at $5.00, $6.35 and $64.79 a month for 10, 100 and 1,000 users. The quota relay sits
at the bottom of that range because its upstream work is capped and its state is two counters.

## Cost dashboard

Every quota request for a known source that passes the session and rate-limit checks writes one
data point to the Analytics Engine dataset `relay_quota` (preflights and earlier refusals write
none, so they are not billable data points): `index1`
and `blob1` are the source, `blob2` the outcome (`complete`, an error code such as `quota_reached`,
or `too_large`, `timeout` or `failed` for a relayed body), `double1` is 1 and `double2` is the HTTP
status. No URL, key or IP is written. Requests by source and outcome over the last day, through the
[SQL API](https://developers.cloudflare.com/analytics/analytics-engine/sql-api/):

```sql
SELECT blob1 AS source, blob2 AS outcome, SUM(_sample_interval * double1) AS requests
FROM relay_quota
WHERE timestamp > NOW() - INTERVAL '1' DAY
GROUP BY source, outcome
ORDER BY source, requests DESC
```

To estimate the month, add up all outcomes and compare them with the Durable Object break-even
above. Worker and Durable Object usage is also on the account's Workers and Durable Objects
dashboards.
