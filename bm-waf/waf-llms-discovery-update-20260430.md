# BettyMills WAF LLM Discovery Update - 2026-04-30

## Scope

Updated the regional AWS WAF Web ACL for the BettyMills production ALB so AI discovery files remain reachable to crawlers and agents without bypassing managed bad-IP/reputation controls.

Web ACL:

- Name: `bettymills-www-edge-protection`
- Scope: `REGIONAL`
- Region: `us-west-2`
- Account/profile used: `bettymills`
- ARN: `arn:aws:wafv2:us-west-2:875533365103:regional/webacl/bettymills-www-edge-protection/a73300ad-14ac-4c8b-a8dd-b5e7ff1488c1`

## Changes Applied

Added non-terminating observability rule:

- `observe-ai-discovery-static`
- Priority: `19`
- Action: `Count`
- Matches `GET` and `HEAD` requests to:
  - `/llms.txt`
  - `/llms-sitemap.xml`
  - `/llms/`
  - `/robots.txt`
  - `/sitemap.xml`
- Hosts:
  - `www.bettymills.com`
  - `bettymills.com`

Added discovery-path exclusions to broad challenge/CAPTCHA source controls so static discovery files are not challenged or CAPTCHA-gated:

- `foreign-risk-captcha-ddos-asns`
- `foreign-risk-challenge-ddos-asns`
- `foreign-risk-captcha-aws-sg-browse`
- `foreign-risk-challenge-high-abuse-country-browse`
- `domestic-precision-captcha-slow-burn-hosting-asns`
- `domestic-precision-challenge-slow-burn-hosting-asns`
- `domestic-precision-captcha-current-attack-ips`
- `domestic-precision-captcha-page-rate-200-per-minute`
- `source-precision-challenge-excessive-get-ips`
- `domestic-precision-challenge-html-get-burst`

The update intentionally leaves these managed controls in place:

- `AWS-AWSManagedRulesKnownBadInputsRuleSet`
- `AWS-AWSManagedRulesSQLiRuleSet`
- `AWS-AWSManagedRulesAmazonIpReputationList`
- `AWS-AWSManagedRulesBotControlRuleSet`

## Validation

Capacity check passed:

- WCU: `1566`

Public ALB/WAF verification from the AI server returned `200`:

- `https://www.bettymills.com/llms.txt`
- `https://www.bettymills.com/llms-sitemap.xml`
- `https://www.bettymills.com/llms/categories/index.txt`
- `https://www.bettymills.com/llms/products/shard-0001.txt`
- `https://www.bettymills.com/robots.txt`
- `https://www.bettymills.com/sitemap.xml`

WAF sampled request verification:

- Rule: `observe-ai-discovery-static`
- Action: `COUNT`
- Sample URI: `/llms/products/shard-0001.txt`

## Backup

Pre-change backup created locally:

- `/Users/j.csandoval/ms-nano-claw/bm-waf/bettymills-www-edge-protection-backup-pre-llms-discovery-20260430T131558PDT.json`

## Replay

The live WAF change is now codified as an idempotent replay script:

```bash
python3 apply_llms_discovery_waf_update.py --apply
```

Run without `--apply` for a dry run and WCU check only.
