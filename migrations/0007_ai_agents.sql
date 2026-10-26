-- AI crawlers, assistants and agents that requested a page. Sent by a small middleware on your site
-- (they don't run JavaScript), or by the script when an automated browser runs it.
CREATE TABLE agent_hits (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  ts INTEGER NOT NULL,
  agent TEXT NOT NULL,      -- 'ChatGPT', 'GPTBot', 'Claude Code', ...
  operator TEXT NOT NULL,   -- 'OpenAI', 'Anthropic', ...
  category TEXT NOT NULL,   -- assistant | search | training | coding | agent | other
  kind TEXT NOT NULL,       -- page | markdown | llms_txt | robots | sitemap | registry | feed | api | asset
  path TEXT NOT NULL,
  hostname TEXT,
  status INTEGER,           -- response status, when the integration can see it
  verified INTEGER,         -- 1: IP is in the operator's published list, 0: claims to be it but isn't, NULL: can't tell
  signed INTEGER NOT NULL DEFAULT 0, -- sent a Web Bot Auth Signature-Agent header
  via TEXT NOT NULL DEFAULT 'server', -- server (middleware) or script (an automated browser ran the tracker)
  country TEXT,
  referrer_domain TEXT
);
CREATE INDEX agent_hits_site_time ON agent_hits (site_id, ts);

-- Published IP ranges of AI operators, refreshed daily, used to verify agent_hits.
CREATE TABLE agent_ip_ranges (
  list TEXT NOT NULL,
  cidr TEXT NOT NULL,
  PRIMARY KEY (list, cidr)
);
CREATE TABLE agent_ip_lists (
  list TEXT PRIMARY KEY,
  fetched_at INTEGER NOT NULL,
  count INTEGER NOT NULL DEFAULT 0,
  error TEXT
);

-- Prompt monitoring: questions asked to ChatGPT / Claude / Perplexity / Gemini on a schedule,
-- to see whether they mention or cite the site.
ALTER TABLE sites ADD COLUMN ai_brand_terms TEXT; -- comma-separated names that count as a mention, e.g. "HextaUI, hexta ui"
ALTER TABLE sites ADD COLUMN ai_monitor_days INTEGER NOT NULL DEFAULT 7; -- re-ask every N days (0 = only when you click Run)

CREATE TABLE ai_prompts (
  id TEXT PRIMARY KEY,
  site_id TEXT NOT NULL,
  prompt TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX ai_prompts_site ON ai_prompts (site_id, created_at);

CREATE TABLE ai_prompt_runs (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id TEXT NOT NULL,
  prompt_id TEXT NOT NULL,
  engine TEXT NOT NULL,     -- chatgpt | claude | perplexity | gemini
  model TEXT,
  ts INTEGER NOT NULL,
  mentioned INTEGER NOT NULL DEFAULT 0, -- the answer names the brand
  cited INTEGER NOT NULL DEFAULT 0,     -- one of the sources is the site
  position INTEGER,                     -- rank of the site among the cited sources (1 = first)
  answer TEXT,
  citations TEXT,                       -- JSON [{url, title}]
  error TEXT
);
CREATE INDEX ai_prompt_runs_prompt ON ai_prompt_runs (site_id, prompt_id, engine, ts);
CREATE INDEX ai_prompt_runs_site_time ON ai_prompt_runs (site_id, ts);
