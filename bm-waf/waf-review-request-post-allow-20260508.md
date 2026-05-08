# Review Request POST WAF Allow

## Purpose

Product review email links submit to:

`POST /invoices/product_review_request`

That path must be present in the `KnownPostPathsExact` regex pattern set used by the `structural-allow-known-post-paths` WAF rule. Without it, legitimate browser submissions are blocked by `structural-block-unknown-post-paths` before the application can create a `Pending` review.

## Current Required Regex

`^/invoices/product_review_request$`

## Durable Reapply Command

```bash
AWS_PROFILE=bettymills python3 apply_review_request_waf_fix.py
```

The script is idempotent. If the regex is missing, it writes a timestamped backup of the pattern set, updates the set, and verifies the allow rule still references `KnownPostPathsExact`.

## Verification

Recent public E2E verification submitted two rendered-email review links through `www.bettymills.com`. Both WAF log entries terminated on `structural-allow-known-post-paths` with `ALLOW`, and both reviews entered `product_reviews` as `Pending`.
