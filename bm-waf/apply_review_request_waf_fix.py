#!/usr/bin/env python3

import json
import subprocess
import tempfile
from datetime import datetime
from pathlib import Path


PROFILE = "bettymills"
REGION = "us-west-2"
WEB_ACL_NAME = "bettymills-www-edge-protection"
WEB_ACL_ID = "a73300ad-14ac-4c8b-a8dd-b5e7ff1488c1"
POST_PATH_SET_NAME = "KnownPostPathsExact"
POST_PATH_SET_ID = "f71728ae-d0dd-4dd1-9c9f-dac76ff303cd"
POST_PATH_SET_ARN = (
    "arn:aws:wafv2:us-west-2:875533365103:regional/regexpatternset/"
    "KnownPostPathsExact/f71728ae-d0dd-4dd1-9c9f-dac76ff303cd"
)
REVIEW_REQUEST_REGEX = r"^/invoices/product_review_request$"
ALLOW_RULE_NAME = "structural-allow-known-post-paths"


def run(args):
    completed = subprocess.run(args, capture_output=True, text=True, check=False)
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "").strip()
        raise RuntimeError(f"command failed: {' '.join(args)} :: {detail}")
    return completed.stdout


def aws(args):
    return ["aws", *args, "--profile", PROFILE, "--region", REGION]


def aws_json(args):
    return json.loads(run(aws(args)))


def write_json_temp(payload):
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as fh:
        json.dump(payload, fh)
        return Path(fh.name)


def update_regex_pattern_set(pattern_set):
    payload = {
        "Name": pattern_set["RegexPatternSet"]["Name"],
        "Scope": "REGIONAL",
        "Id": pattern_set["RegexPatternSet"]["Id"],
        "RegularExpressionList": pattern_set["RegexPatternSet"]["RegularExpressionList"],
        "LockToken": pattern_set["LockToken"],
    }
    if pattern_set["RegexPatternSet"].get("Description"):
        payload["Description"] = pattern_set["RegexPatternSet"]["Description"]

    path = write_json_temp(payload)
    try:
        run(aws(["wafv2", "update-regex-pattern-set", "--cli-input-json", f"file://{path}"]))
    finally:
        path.unlink(missing_ok=True)


def pattern_set_referenced(statement):
    if "RegexPatternSetReferenceStatement" in statement:
        return statement["RegexPatternSetReferenceStatement"].get("ARN") == POST_PATH_SET_ARN
    for key in ("AndStatement", "OrStatement"):
        group = statement.get(key)
        if group and any(pattern_set_referenced(item) for item in group.get("Statements", [])):
            return True
    if "NotStatement" in statement:
        return pattern_set_referenced(statement["NotStatement"]["Statement"])
    return False


def verify_allow_rule():
    acl = aws_json(
        [
            "wafv2",
            "get-web-acl",
            "--scope",
            "REGIONAL",
            "--id",
            WEB_ACL_ID,
            "--name",
            WEB_ACL_NAME,
        ]
    )
    rule = next((item for item in acl["WebACL"]["Rules"] if item["Name"] == ALLOW_RULE_NAME), None)
    if not rule:
        raise RuntimeError(f"missing expected WAF rule: {ALLOW_RULE_NAME}")
    if rule.get("Action") != {"Allow": {}}:
        raise RuntimeError(f"{ALLOW_RULE_NAME} is not an Allow rule")
    if not pattern_set_referenced(rule["Statement"]):
        raise RuntimeError(f"{ALLOW_RULE_NAME} does not reference {POST_PATH_SET_NAME}")
    return {"priority": rule["Priority"], "metric": rule["VisibilityConfig"]["MetricName"]}


def main():
    stamp = datetime.now().strftime("%Y%m%dT%H%M%S")
    pattern_set = aws_json(
        [
            "wafv2",
            "get-regex-pattern-set",
            "--scope",
            "REGIONAL",
            "--id",
            POST_PATH_SET_ID,
            "--name",
            POST_PATH_SET_NAME,
        ]
    )

    regexes = pattern_set["RegexPatternSet"]["RegularExpressionList"]
    changed = False
    backup_path = None
    if not any(item.get("RegexString") == REVIEW_REQUEST_REGEX for item in regexes):
        backup_path = Path(f"{POST_PATH_SET_NAME}-backup-pre-review-request-{stamp}.json")
        backup_path.write_text(json.dumps(pattern_set, indent=2) + "\n")
        regexes.append({"RegexString": REVIEW_REQUEST_REGEX})
        update_regex_pattern_set(pattern_set)
        changed = True

    allow_rule = verify_allow_rule()
    print(
        json.dumps(
            {
                "regex_pattern_set": POST_PATH_SET_NAME,
                "regex": REVIEW_REQUEST_REGEX,
                "updated": changed,
                "backup": str(backup_path) if backup_path else "",
                "allow_rule": ALLOW_RULE_NAME,
                "allow_rule_priority": allow_rule["priority"],
                "allow_rule_metric": allow_rule["metric"],
            },
            indent=2,
        )
    )


if __name__ == "__main__":
    main()
