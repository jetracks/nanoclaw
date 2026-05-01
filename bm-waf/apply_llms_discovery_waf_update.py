#!/usr/bin/env python3

import argparse
import base64
import copy
import json
import subprocess
import tempfile
from datetime import datetime
from pathlib import Path


PROFILE = "bettymills"
REGION = "us-west-2"
WEB_ACL_NAME = "bettymills-www-edge-protection"
WEB_ACL_ID = "a73300ad-14ac-4c8b-a8dd-b5e7ff1488c1"

DISCOVERY_PATHS = (
    ("/llms.txt", "EXACTLY"),
    ("/llms-sitemap.xml", "EXACTLY"),
    ("/llms/", "STARTS_WITH"),
    ("/robots.txt", "EXACTLY"),
    ("/sitemap.xml", "EXACTLY"),
)

STATIC_EXCLUSION_RULES = {
    "foreign-risk-captcha-ddos-asns",
    "foreign-risk-challenge-ddos-asns",
    "foreign-risk-captcha-aws-sg-browse",
    "foreign-risk-challenge-high-abuse-country-browse",
    "domestic-precision-captcha-slow-burn-hosting-asns",
    "domestic-precision-challenge-slow-burn-hosting-asns",
    "domestic-precision-captcha-current-attack-ips",
    "domestic-precision-captcha-page-rate-200-per-minute",
    "source-precision-challenge-excessive-get-ips",
}

HTML_BURST_RULE = "domestic-precision-challenge-html-get-burst"
OBSERVE_RULE = "observe-ai-discovery-static"


def run(args):
    completed = subprocess.run(args, capture_output=True, text=True, check=False)
    if completed.returncode != 0:
        detail = (completed.stderr or completed.stdout or "").strip()
        raise RuntimeError(f"command failed: {' '.join(args)} :: {detail}")
    return completed.stdout


def aws(args, profile, region):
    return ["aws", *args, "--profile", profile, "--region", region]


def aws_json(args, profile, region):
    return json.loads(run(aws(args, profile, region)))


def b64(value):
    return base64.b64encode(value.encode("utf-8")).decode("ascii")


def byte_uri(path, constraint):
    return {
        "ByteMatchStatement": {
            "SearchString": b64(path),
            "FieldToMatch": {"UriPath": {}},
            "TextTransformations": [{"Priority": 0, "Type": "NONE"}],
            "PositionalConstraint": constraint,
        }
    }


def byte_method(method):
    return {
        "ByteMatchStatement": {
            "SearchString": b64(method),
            "FieldToMatch": {"Method": {}},
            "TextTransformations": [{"Priority": 0, "Type": "NONE"}],
            "PositionalConstraint": "EXACTLY",
        }
    }


def byte_header(name, value):
    return {
        "ByteMatchStatement": {
            "SearchString": b64(value),
            "FieldToMatch": {"SingleHeader": {"Name": name}},
            "TextTransformations": [{"Priority": 0, "Type": "LOWERCASE"}],
            "PositionalConstraint": "EXACTLY",
        }
    }


def discovery_statements():
    return [byte_uri(path, constraint) for path, constraint in DISCOVERY_PATHS]


def uri_key(statement):
    byte_match = statement.get("ByteMatchStatement")
    if not byte_match or "UriPath" not in byte_match.get("FieldToMatch", {}):
        return None
    return byte_match.get("SearchString"), byte_match.get("PositionalConstraint")


def append_discovery_exclusion(rule):
    def recurse(node):
        if isinstance(node, dict):
            not_statement = node.get("NotStatement")
            if not_statement:
                or_statement = not_statement.get("Statement", {}).get("OrStatement")
                if or_statement and any(uri_key(item) for item in or_statement.get("Statements", [])):
                    existing = {uri_key(item) for item in or_statement["Statements"] if uri_key(item)}
                    added = 0
                    for statement in discovery_statements():
                        key = uri_key(statement)
                        if key not in existing:
                            or_statement["Statements"].append(copy.deepcopy(statement))
                            added += 1
                    return added
            for value in node.values():
                result = recurse(value)
                if result is not None:
                    return result
        elif isinstance(node, list):
            for value in node:
                result = recurse(value)
                if result is not None:
                    return result
        return None

    result = recurse(rule["Statement"])
    if result is None:
        raise RuntimeError(f"could not find static exclusion list in {rule['Name']}")
    return result


def ensure_html_burst_exclusion(rule):
    statements = rule["Statement"]["RateBasedStatement"]["ScopeDownStatement"]["AndStatement"]["Statements"]
    encoded = json.dumps(statements)
    if b64("/llms.txt") in encoded and b64("/llms/") in encoded:
        return False
    statements.append(
        {
            "NotStatement": {
                "Statement": {
                    "OrStatement": {
                        "Statements": discovery_statements(),
                    }
                }
            }
        }
    )
    return True


def ensure_observe_rule(web_acl):
    if any(rule["Name"] == OBSERVE_RULE for rule in web_acl["Rules"]):
        return False
    web_acl["Rules"].append(
        {
            "Name": OBSERVE_RULE,
            "Priority": 19,
            "Statement": {
                "AndStatement": {
                    "Statements": [
                        {
                            "OrStatement": {
                                "Statements": [
                                    byte_header("host", "www.bettymills.com"),
                                    byte_header("host", "bettymills.com"),
                                ]
                            }
                        },
                        {"OrStatement": {"Statements": [byte_method("GET"), byte_method("HEAD")]}},
                        {"OrStatement": {"Statements": discovery_statements()}},
                    ]
                }
            },
            "Action": {"Count": {}},
            "VisibilityConfig": {
                "SampledRequestsEnabled": True,
                "CloudWatchMetricsEnabled": True,
                "MetricName": OBSERVE_RULE,
            },
        }
    )
    return True


def update_payload(acl):
    web_acl = acl["WebACL"]
    payload = {
        "Name": web_acl["Name"],
        "Scope": "REGIONAL",
        "Id": web_acl["Id"],
        "DefaultAction": web_acl["DefaultAction"],
        "Description": web_acl.get("Description", ""),
        "Rules": sorted(web_acl["Rules"], key=lambda item: item["Priority"]),
        "VisibilityConfig": web_acl["VisibilityConfig"],
        "LockToken": acl["LockToken"],
    }
    for key in (
        "CustomResponseBodies",
        "CaptchaConfig",
        "ChallengeConfig",
        "TokenDomains",
        "AssociationConfig",
        "OnSourceDDoSProtectionConfig",
    ):
        if key in web_acl:
            payload[key] = web_acl[key]
    return payload


def write_temp_json(payload):
    with tempfile.NamedTemporaryFile("w", suffix=".json", delete=False) as handle:
        json.dump(payload, handle)
        return Path(handle.name)


def main():
    parser = argparse.ArgumentParser(description="Apply BettyMills /llms discovery WAF protections.")
    parser.add_argument("--profile", default=PROFILE)
    parser.add_argument("--region", default=REGION)
    parser.add_argument("--apply", action="store_true", help="Update the live Web ACL. Default is dry run.")
    args = parser.parse_args()

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
        ],
        args.profile,
        args.region,
    )
    stamp = datetime.now().strftime("%Y%m%dT%H%M%S")
    backup = Path(f"{WEB_ACL_NAME}-backup-pre-llms-discovery-{stamp}.json")
    backup.write_text(json.dumps(acl, indent=2) + "\n", encoding="utf-8")

    changes = {}
    for rule in acl["WebACL"]["Rules"]:
        if rule["Name"] in STATIC_EXCLUSION_RULES:
            changes[rule["Name"]] = append_discovery_exclusion(rule)
        elif rule["Name"] == HTML_BURST_RULE:
            changes[rule["Name"]] = int(ensure_html_burst_exclusion(rule))

    changes[OBSERVE_RULE] = "added" if ensure_observe_rule(acl["WebACL"]) else "exists"
    changed = any(value not in (0, "exists") for value in changes.values())

    payload = update_payload(acl)
    rules_path = write_temp_json(payload["Rules"])
    try:
        capacity = aws_json(
            ["wafv2", "check-capacity", "--scope", "REGIONAL", "--rules", f"file://{rules_path}"],
            args.profile,
            args.region,
        )
    finally:
        rules_path.unlink(missing_ok=True)

    if args.apply and changed:
        payload_path = write_temp_json(payload)
        try:
            aws_json(["wafv2", "update-web-acl", "--cli-input-json", f"file://{payload_path}"], args.profile, args.region)
        finally:
            payload_path.unlink(missing_ok=True)

    print(
        json.dumps(
            {
                "apply": args.apply,
                "changed": changed,
                "changes": changes,
                "capacity": capacity.get("Capacity"),
                "backup": str(backup),
            },
            indent=2,
            sort_keys=True,
        )
    )


if __name__ == "__main__":
    main()
