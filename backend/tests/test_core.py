#! /usr/bin/env python3
# coding=utf-8
"""核心逻辑离线单元测试（不依赖真实 AC 设备）。"""

from __future__ import annotations

import pytest

from app.core.security import CredentialDecryptError, decrypt, encrypt
from app.sangfor.web_client import SangforWebClient, SangforWebError
from app.services import customrule_form, policy_relations
from app.services.sync_service import _diff_snapshots


def test_encrypt_roundtrip():
    secret = "p@ssw0rd-深信服"
    token = encrypt(secret)
    assert token and token != secret
    assert decrypt(token) == secret
    assert encrypt("") == ""
    assert decrypt("") == ""
    with pytest.raises(CredentialDecryptError):
        decrypt("not-a-valid-token")


def test_session_pool_wraps_decrypt_error_as_sangfor_web_error():
    """主密钥不匹配时，session_pool 应转成 SangforWebError（路由层已知如何处理），而非静默返回空密码。"""
    from app.sangfor import session_pool

    with pytest.raises(SangforWebError, match="Web 密码"):
        session_pool._decrypt_or_raise("not-a-valid-token", field="Web 密码：")


def test_audit_log_out_serializes_created_at_with_utc_offset():
    """库存的无时区 UTC 时间序列化必须带时区标记，否则前端 new Date() 当本地时间解析、显示差 8 小时。"""
    from datetime import datetime, timezone

    from app.schemas.common import AuditLogOut

    out = AuditLogOut(
        id=1, created_at=datetime(2026, 7, 1, 2, 43, 0), actor="admin", instance_id=None,
        instance_name="", object_type="policy", object_name="p", action="delete",
        success=True, message="", before="", after="",
    )
    assert out.created_at.tzinfo == timezone.utc
    dumped = out.model_dump_json()
    assert "02:43:00Z" in dumped or "02:43:00+00:00" in dumped


def _client() -> SangforWebClient:
    c = SangforWebClient("https", "127.0.0.1", 443, "u", "p")
    c._logged_in = True  # 跳过真实登录
    c._policy_cgi_detected = True  # 跳过策略 CGI 路径探测（默认 netpolicy.cgi）
    return c


def test_write_dry_run_returns_payload():
    c = _client()
    result = c.delete_custom_rule("测试规则", dry_run=True)
    assert result["dry_run"] is True
    assert result["payload"]["opr"] == "delete"
    assert result["payload"]["name"] == ["测试规则"]


def test_write_blocked_when_not_confirmed():
    """未登记到 CONFIRMED_WRITES 的写操作在 dry_run=False 时应被白名单闸门拦截。"""
    c = _client()
    with pytest.raises(SangforWebError):
        c._write_cgi("/cgi-bin/netpolicy.cgi", {"opr": "edit", "name": "某策略"}, dry_run=False)


def test_url_group_write_payloads_match_capture():
    """URL 库增删改报文应与真实抓包一致：add/modify 带 data，delete 的 name 为数组。"""
    c = _client()
    add = c.create_url_group(
        {"id": "", "name": "test2", "depict": "", "url": "1.1.1.1\n2.2.2.2", "keyword": "test.test.com"},
        dry_run=True,
    )
    assert add["payload"] == {
        "opr": "add",
        "data": {"id": "", "name": "test2", "depict": "", "url": "1.1.1.1\n2.2.2.2", "keyword": "test.test.com"},
    }
    mod = c.update_url_group({"id": "", "name": "test2", "depict": "", "url": "a\nb\nc", "keyword": "k"}, dry_run=True)
    assert mod["payload"]["opr"] == "modify"
    assert mod["payload"]["data"]["url"] == "a\nb\nc"
    dele = c.delete_url_group("test2", dry_run=True)
    assert dele["payload"] == {"opr": "delete", "name": ["test2"]}


def test_write_allowed_after_confirm(monkeypatch):
    """已确认的 customrule 删除可真实提交。"""
    c = _client()
    monkeypatch.setattr(c, "_post", lambda path, payload: {"success": True})
    result = c.delete_custom_rule("测试规则", dry_run=False)
    assert result["dry_run"] is False
    assert result["result"]["success"] is True


class _FakeResp:
    def __init__(self, *, status=200, text="", json_ok=False, payload=None):
        self.status_code = status
        self.text = text
        self.apparent_encoding = "utf-8"
        self.encoding = "utf-8"
        self._json_ok = json_ok
        self._payload = payload or {}

    def json(self):
        if not self._json_ok:
            raise ValueError("not json")
        return self._payload


def test_post_non_json_retries_then_raises(monkeypatch):
    """响应始终非 JSON：重登重试一次后抛出 SangforWebError（而非 500）。"""
    c = _client()
    calls = {"post": 0}
    monkeypatch.setattr(c, "login", lambda: None)

    def fake_post(*a, **k):
        calls["post"] += 1
        return _FakeResp(text="<html>login</html>")

    monkeypatch.setattr(c.session, "post", fake_post)
    with pytest.raises(SangforWebError):
        c._post("/cgi-bin/customrule.cgi", {"opr": "list"})
    assert calls["post"] == 2  # 原始一次 + 重登重试一次


def test_post_relogin_recovers(monkeypatch):
    """首次非 JSON、重登后成功：应正常返回数据。"""
    c = _client()
    seq = [
        _FakeResp(text=""),
        _FakeResp(json_ok=True, payload={"success": True, "data": [1, 2]}),
    ]
    monkeypatch.setattr(c, "login", lambda: None)
    monkeypatch.setattr(c.session, "post", lambda *a, **k: seq.pop(0))
    result = c._post("/x", {"opr": "list"})
    assert result["data"] == [1, 2]


def test_policy_detail_parsing(monkeypatch):
    fake = {
        "appctrl": {
            "application": {
                "data": [
                    {
                        "name": "规则A",
                        "action": "deny",
                        "apps": {"apps": [{"path": "自定义应用/钉钉"}, {"path": "即时通讯/微信"}]},
                        "url": [{"path": "自定义URL/公司内网"}],
                    }
                ]
            }
        }
    }
    c = _client()
    monkeypatch.setattr(c, "_post", lambda path, payload: fake)
    detail = c.get_policy_detail("钉钉白名单")
    assert detail["policy_name"] == "钉钉白名单"
    rule = detail["rules"][0]
    assert rule["action"] == "deny"
    assert {a["path"] for a in rule["apps"]} == {"自定义应用/钉钉", "即时通讯/微信"}
    custom = {a["path"] for a in rule["apps"] if a["custom"]}
    assert custom == {"自定义应用/钉钉"}
    assert rule["urls"][0]["name"] == "自定义URL/公司内网"
    assert rule["urls"][0]["custom"] is True


def test_policy_detail_parsing_tolerates_app_reference_variants(monkeypatch):
    fake = {
        "appctrl": {
            "application": {
                "data": [
                    {
                        "name": "规则A",
                        "apps": [
                            {"name": "业务/自定义应用/钉钉"},
                            {"text": "即时通讯/微信"},
                            "自定义应用_飞书",
                        ],
                        "website": {"data": [{"url": {"name": "URL库/自定义/研发"}}]},
                    }
                ]
            }
        }
    }
    c = _client()
    monkeypatch.setattr(c, "_post", lambda path, payload: fake)
    rule = c.get_policy_detail("应用策略")["rules"][0]
    assert {a["path"] for a in rule["apps"]} == {"业务/自定义应用/钉钉", "即时通讯/微信", "自定义应用_飞书"}
    assert {a["path"] for a in rule["apps"] if a["custom"]} == {"业务/自定义应用/钉钉", "自定义应用_飞书"}
    assert rule["urls"][0]["name"] == "URL库/自定义/研发"


def test_policy_detail_parsing_extracts_chinese_access_website_url_group(monkeypatch):
    fake = {
        "appctrl": {
            "application": {
                "data": [
                    {
                        "name": "规则A",
                        "condition": {
                            "访问网站": {
                                "URL库": [{"id": "url-1", "name": "公司内网"}, {"path": "URL库/研发"}]
                            }
                        },
                    }
                ]
            }
        }
    }
    c = _client()
    monkeypatch.setattr(c, "_post", lambda path, payload: fake)
    rule = c.get_policy_detail("URL白名单")["rules"][0]
    assert [item["name"] for item in rule["urls"]] == ["url-1", "公司内网", "URL库/研发"]


def test_policy_detail_parsing_extracts_access_website_app_paths(monkeypatch):
    fake = {
        "appctrl": {
            "application": {
                "data": [
                    {
                        "name": "1754552697210210",
                        "apps": {
                            "apps": [
                                {"path": "访问网站/钉钉白名单/文件上传", "type": "power"},
                                {"path": "IM传文件/钉钉_传图片", "type": "app"},
                            ],
                            "tags": [],
                            "extra": [],
                        },
                    },
                    {
                        "name": "1754552718772772",
                        "apps": {
                            "apps": [
                                {"path": "访问网站/钉钉白名单/网站浏览", "type": "power"},
                                {"path": "访问网站/钉钉白名单/HTTPS", "type": "power"},
                                {"path": "钉钉/钉钉", "type": "app"},
                            ],
                            "tags": [],
                            "extra": [],
                        },
                    },
                ],
                "include": True,
            }
        }
    }
    c = _client()
    monkeypatch.setattr(c, "_post", lambda path, payload: fake)
    detail = c.get_policy_detail("钉钉白名单策略")
    assert [item["name"] for item in detail["rules"][0]["urls"]] == ["钉钉白名单"]
    assert [item["name"] for item in detail["rules"][1]["urls"]] == ["钉钉白名单"]


def test_build_policy_links_matches_path_segments_and_prefixed_names():
    class FakeWeb:
        def list_policies(self):
            return {
                "access_policies": [
                    {"name": "办公策略"},
                    {"name": "研发策略"},
                    {"name": "内置应用策略"},
                ]
            }

        def get_policy_detail(self, policy_name):
            details = {
                "办公策略": {
                    "rules": [
                        {
                            "apps": [
                                {"path": "业务/自定义应用/钉钉", "custom": True},
                                {"path": "即时通讯/微信", "custom": False},
                            ]
                        }
                    ]
                },
                "研发策略": {"rules": [{"apps": [{"path": "自定义应用_飞书", "custom": True}]}]},
                "内置应用策略": {"rules": [{"apps": [{"path": "即时通讯/微信", "custom": False}]}]},
            }
            return details[policy_name]

    rules = [
        {"rulename": "dingding-rule", "appname": "钉钉", "apptype": "协作"},
        {"rulename": "feishu-rule", "appname": "自定义应用_飞书", "apptype": "协作"},
    ]
    links, policy_names = policy_relations._build_policy_links(FakeWeb(), rules, [])
    assert policy_names == ["内置应用策略", "办公策略", "研发策略"]
    assert links == [
        {"policy": "办公策略", "app": "dingding-rule", "action": "unknown"},
        {"policy": "研发策略", "app": "feishu-rule", "action": "unknown"},
    ]


def test_build_policy_relations_matches_custom_urls():
    class FakeWeb:
        def list_url_groups(self):
            # 自定义库 inside=0，内置库 inside=1（与设备一致，靠 inside 区分而非名称）
            return {
                "flat": [
                    {
                        "id": "url-1",
                        "name": "公司内网",
                        "full_path": "URL库/公司内网",
                        "depict": "",
                        "leaf": True,
                        "inside": 0,
                    },
                    {"name": "研发", "full_path": "URL库/研发", "depict": "", "leaf": True, "inside": 0},
                    {"name": "广告", "full_path": "URL库/广告", "depict": "", "leaf": True, "inside": 1},
                ]
            }

        def list_policies(self):
            return {"access_policies": [{"name": "办公策略"}, {"name": "研发策略"}, {"name": "内置URL策略"}]}

        def get_policy_detail(self, policy_name):
            details = {
                "办公策略": {
                    "rules": [
                        {"index": 1, "name": "办公规则1", "urls": [{"name": "url-1", "custom": True}]},
                        {"index": 2, "name": "办公规则2", "urls": [{"name": "公司内网", "custom": True}]},
                    ]
                },
                "研发策略": {"rules": [{"index": 1, "name": "研发规则", "urls": [{"name": "研发", "custom": True}]}]},
                "内置URL策略": {"rules": [{"urls": [{"name": "广告", "custom": False}]}]},
            }
            return details[policy_name]

    app_links, url_links, policy_names, url_nodes = policy_relations._build_policy_relations(
        FakeWeb(),
        [],
        [],
    )
    assert app_links == []
    assert policy_names == ["内置URL策略", "办公策略", "研发策略"]
    assert [node["name"] for node in url_nodes] == ["公司内网", "研发"]
    assert url_links == [
        {
            "policy": "办公策略",
            "url": "公司内网",
            "rules": [{"index": 1, "name": "办公规则1"}, {"index": 2, "name": "办公规则2"}],
            "action": "unknown",
        },
        {"policy": "研发策略", "url": "研发", "rules": [{"index": 1, "name": "研发规则"}], "action": "unknown"},
    ]


def test_build_policy_relations_links_access_website_url_library():
    class FakeWeb:
        def list_url_groups(self):
            return {
                "flat": [
                    {
                        "id": "2357005289",
                        "name": "钉钉白名单",
                        "full_path": "URL库/钉钉白名单",
                        "depict": "",
                        "leaf": True,
                        "inside": 0,
                    }
                ]
            }

        def list_policies(self):
            return {"access_policies": [{"name": "钉钉访问策略"}]}

        def get_policy_detail(self, policy_name):
            return {
                "rules": [
                    {
                        "index": 1,
                        "name": "1754552697210210",
                        "urls": [{"name": "钉钉白名单", "custom": False}],
                    }
                ]
            }

    _, url_links, _, _ = policy_relations._build_policy_relations(FakeWeb(), [], [])

    assert url_links == [
        {
            "policy": "钉钉访问策略",
            "url": "钉钉白名单",
            "rules": [{"index": 1, "name": "1754552697210210"}],
            "action": "unknown",
        }
    ]


def test_build_policy_relations_action_follows_first_matching_rule():
    """连线 action 按「首条命中规则」为准（深信服自上而下匹配）。"""

    class FakeWeb:
        def list_url_groups(self):
            return {
                "flat": [
                    {"name": "白名单", "full_path": "URL库/白名单", "leaf": True, "inside": 0},
                ]
            }

        def list_policies(self):
            return {"access_policies": [{"name": "策略A"}]}

        def get_policy_detail(self, policy_name):
            # app「钉钉」先被放行规则(1)引用、后被拒绝规则(2)引用 → 以首条放行为准 = allow
            # app「飞书」只被拒绝规则(2)引用 → deny；URL「白名单」只被放行规则(1)引用 → allow
            return {
                "rules": [
                    {
                        "index": 1,
                        "name": "r-allow",
                        "action": "allow",
                        "apps": [{"path": "自定义应用/钉钉", "custom": True}],
                        "urls": [{"name": "白名单", "custom": True}],
                    },
                    {
                        "index": 2,
                        "name": "r-deny",
                        "action": "deny",
                        "apps": [
                            {"path": "自定义应用/钉钉", "custom": True},
                            {"path": "自定义应用/飞书", "custom": True},
                        ],
                    },
                ]
            }

    rules = [
        {"rulename": "钉钉", "appname": "钉钉", "apptype": "协作"},
        {"rulename": "飞书", "appname": "飞书", "apptype": "协作"},
    ]
    app_links, url_links, _, _ = policy_relations._build_policy_relations(FakeWeb(), rules, [])
    app_action = {link["app"]: link["action"] for link in app_links}
    assert app_action == {"钉钉": "allow", "飞书": "deny"}
    assert url_links[0]["action"] == "allow"


def test_linked_url_summaries_are_kept_when_content_fetch_fails():
    urls = []
    policy_url_links = [
        {"policy": "办公策略", "url": "公司内网", "rules": [{"index": 1, "name": "办公规则"}]},
        {"policy": "研发策略", "url": "研发", "rules": []},
    ]

    summaries = policy_relations._ensure_linked_url_summaries(urls, policy_url_links)

    assert summaries == [
        {"name": "公司内网", "url_count": 0, "urls": []},
        {"name": "研发", "url_count": 0, "urls": []},
    ]


def test_customrule_build_payload_matches_capture():
    """build_payload 应产出与真实抓包一致的 data 结构。"""
    form = {
        "status": True,
        "rulename": "for_troubleshooting",
        "depict": "",
        "apptype": "for_troubleshooting",
        "appname": "for_troubleshooting",
        "direction": "both",
        "protocol": "1",
        "protocol_num": "0",
        "port_mode": "all",
        "port_range": "",
        "ip_mode": "specified",
        "ip_range": "118.212.235.68\n1.1.1.1\n",
        "domain": "",
    }
    data = customrule_form.build_payload(form)
    assert data["basic"] == {
        "name": "for_troubleshooting",
        "depict": "",
        "type": "for_troubleshooting",
        "appname": "for_troubleshooting",
    }
    pk = data["packet"]
    assert (pk["0"], pk["1"], pk["2"], pk["direction"]) == (True, False, False, "0")
    assert pk["protocol"] == 1 and pk["pn"] == 0
    assert pk["port"] == "all_port" and pk["all_port"] is True
    assert pk["specified_port"] == {"port_range": "", "enable": False}
    assert pk["ip"] == "specified_ip" and pk["all_ip"] is False
    assert pk["specified_ip"] == {"ip_range": "118.212.235.68\n1.1.1.1\n", "enable": True}
    assert pk["site"] == ""
    assert data["enable"] is True


def test_customrule_modify_envelope_matches_capture():
    """编辑(modify)整体报文与真实抓包一致：opr=modify + data={basic,packet,enable}，无 oldData。"""
    form = {
        "status": True,
        "rulename": "for_troubleshooting",
        "depict": "",
        "apptype": "for_troubleshooting",
        "appname": "for_troubleshooting",
        "direction": "both",
        "protocol": "1",
        "protocol_num": "0",
        "port_mode": "all",
        "port_range": "",
        "ip_mode": "specified",
        "ip_range": "118.212.235.68\n1.1.1.1\n",
        "domain": "",
    }
    c = _client()
    body = c.update_custom_rule(customrule_form.build_payload(form), dry_run=True)["payload"]
    assert body["opr"] == "modify"
    assert "oldData" not in body  # 设备按 data.basic.name 定位，modify 无需额外标识
    assert body["data"]["basic"] == {
        "name": "for_troubleshooting",
        "depict": "",
        "type": "for_troubleshooting",
        "appname": "for_troubleshooting",
    }
    assert body["data"]["packet"]["specified_ip"] == {"ip_range": "118.212.235.68\n1.1.1.1\n", "enable": True}
    assert body["data"]["enable"] is True


def test_customrule_build_payload_add_capture():
    """新增(add)报文：protocol 默认 0、pn 留空为空串、ip 指定。"""
    form = {
        "status": True,
        "rulename": "1",
        "depict": "1",
        "apptype": "自定义1",
        "appname": "自定义1",
        "direction": "both",
        "protocol": "0",
        "protocol_num": "",
        "port_mode": "all",
        "port_range": "",
        "ip_mode": "specified",
        "ip_range": "1.1.1.1",
        "domain": "",
    }
    data = customrule_form.build_payload(form)
    assert data["basic"] == {"name": "1", "depict": "1", "type": "自定义1", "appname": "自定义1"}
    pk = data["packet"]
    assert pk["protocol"] == 0 and pk["pn"] == ""
    assert pk["port"] == "all_port" and pk["all_port"] is True
    assert pk["specified_port"]["enable"] is False
    assert pk["ip"] == "specified_ip" and pk["all_ip"] is False
    assert pk["specified_ip"] == {"ip_range": "1.1.1.1", "enable": True}
    assert data["enable"] is True


def test_customrule_parse_form_roundtrip():
    """parse_form -> build_payload 应还原关键字段，且去除「自定义应用_」前缀。"""
    summary = {
        "rulename": "r1",
        "appname": "自定义应用_r1",
        "apptype": "自定义应用_t1",
        "depict": "d",
        "status": True,
    }
    detail = {
        "packet": {
            "direction": "1",
            "protocol": 2,
            "pn": 0,
            "port": "specified_port",
            "specified_port": {"port_range": "80,443", "enable": True},
            "ip": "all_ip",
            "specified_ip": {"ip_range": "", "enable": False},
            "site": "a.com",
        }
    }
    form = customrule_form.parse_form(summary, detail)
    assert form["appname"] == "r1" and form["apptype"] == "t1"
    assert form["direction"] == "lan2wan"
    assert form["protocol"] == "2"
    assert form["port_mode"] == "specified" and form["port_range"] == "80,443"
    assert form["ip_mode"] == "all"
    assert form["domain"] == "a.com"

    data = customrule_form.build_payload(form)
    assert data["packet"]["direction"] == "1"
    assert data["packet"]["specified_port"]["port_range"] == "80,443"


def test_diff_snapshots():
    src = {"a": 1, "b": 2, "c": 3}
    tgt = {"a": 1, "b": 9}
    diffs = _diff_snapshots(src, tgt)
    fields = {d.field: (d.source, d.target) for d in diffs}
    assert fields == {"b": (2, 9), "c": (3, None)}


# 来自真实「修改策略」抓包的最小结构：规则名为数字 ID，引用带 path/type/crc/extra。
_POLICY_LISTITEM = {
    "success": True,
    "name": "fortest",
    "depict": "",
    "type": 1,
    "enable": True,
    "expire": "never",
    "appctrl": {
        "application": {
            "include": True,
            "data": [
                {
                    "name": "1777345838622622",
                    "time": "全天",
                    "action": True,
                    "apps": {
                        "apps": [
                            {"path": "字节跳动基础数据/字节跳动基础服务", "type": "app", "crc": "2162566168"}
                        ],
                        "tags": [],
                        "extra": [],
                    },
                },
                {
                    "name": "1781501857168168",
                    "time": "全天",
                    "action": False,
                    "apps": {
                        "apps": [
                            {"type": "catagory", "path": "访问网站/全部", "crc": "3281598801", "extra": "url"},
                            {"type": "catagory", "path": "自定义应用_基础云生产环境/全部", "crc": "3885605386"},
                        ],
                        "tags": [],
                        "extra": [],
                    },
                },
            ],
        },
        "network": {"data": [], "include": False},
    },
    "keyword": {"include": False},
}


def test_policy_detail_exposes_canonical_refs(monkeypatch):
    """get_policy_detail 应暴露可往返编辑的 refs（含 crc/kind/custom）与 action_bool。"""
    import copy

    c = _client()
    monkeypatch.setattr(c, "_post", lambda path, payload: copy.deepcopy(_POLICY_LISTITEM))
    detail = c.get_policy_detail("fortest")

    assert detail["application_include"] is True
    r0, r1 = detail["rules"]
    assert r0["rule_id"] == "1777345838622622"
    assert r0["action_bool"] is True
    assert r0["refs"] == [
        {
            "path": "字节跳动基础数据/字节跳动基础服务",
            "type": "app",
            "crc": "2162566168",
            "extra": "",
            "custom": False,
            "kind": "app",
        }
    ]
    assert r1["action_bool"] is False
    # 访问网站(extra=url) → kind=url；自定义应用_ → custom=True
    url_ref = next(x for x in r1["refs"] if x["path"] == "访问网站/全部")
    assert url_ref["kind"] == "url" and url_ref["extra"] == "url"
    custom_ref = next(x for x in r1["refs"] if x["path"].startswith("自定义应用_"))
    assert custom_ref["custom"] is True and custom_ref["crc"] == "3885605386"


def test_modify_policy_application_roundtrips_and_preserves_fields(monkeypatch):
    """modify_policy_application 应读回完整策略对象，仅替换规则动作与引用，其余字段保留。"""
    import copy

    c = _client()
    monkeypatch.setattr(c, "_post", lambda path, payload: copy.deepcopy(_POLICY_LISTITEM))

    # 编辑：把规则1改为禁止并移除其引用；规则2保留 URL、移除自定义应用，改为允许
    rules = [
        {"name": "1777345838622622", "action": False, "refs": []},
        {
            "name": "1781501857168168",
            "action": True,
            "refs": [
                {"path": "访问网站/全部", "type": "catagory", "crc": "3281598801", "extra": "url"}
            ],
        },
    ]
    result = c.modify_policy_application("fortest", rules, application_include=False, dry_run=True)

    assert result["dry_run"] is True
    body = result["payload"]
    assert body["opr"] == "modify"
    data = body["data"]
    # 响应信封键被剔除，但策略本体字段保留
    assert "success" not in data
    assert data["name"] == "fortest" and data["type"] == 1 and data["expire"] == "never"
    assert data["keyword"] == {"include": False}

    application = data["appctrl"]["application"]
    assert application["include"] is False  # include 被覆盖
    d0, d1 = application["data"]
    # 规则1：动作改为禁止、引用清空，但 time/tags/extra 等原字段保留
    assert d0["action"] is False and d0["apps"]["apps"] == []
    assert d0["time"] == "全天" and d0["apps"]["tags"] == []
    # 规则2：动作改为允许，仅保留 URL 引用（含原 crc 与 extra）
    assert d1["action"] is True
    assert d1["apps"]["apps"] == [
        {"path": "访问网站/全部", "type": "catagory", "crc": "3281598801", "extra": "url"}
    ]


def test_list_app_tree_returns_tags_and_data(monkeypatch):
    """list_app_tree 应调用 acnetpolicy listAppTree 并原样返回 tags + data 树。"""
    fake = {
        "success": True,
        "tags": [{"id": "3147619651", "name": "SaaS应用", "description": "SaaS应用"}],
        "data": [
            {
                "crc": "1",
                "name": "全部",
                "type": "catagory",
                "children": [
                    {
                        "crc": "3281598801",
                        "name": "访问网站",
                        "type": "catagory",
                        "value": "访问网站/全部",
                        "children": [],
                    }
                ],
            }
        ],
    }
    c = _client()
    seen: dict = {}

    def fake_post(path, payload):
        seen["path"] = path
        seen["payload"] = payload
        return fake

    monkeypatch.setattr(c, "_post", fake_post)
    out = c.list_app_tree()
    assert seen["path"] == c.ACNETPOLICY_CGI
    assert seen["payload"]["opr"] == "listAppTree"
    # 必须对齐原生请求：containUrlType=False 时「访问网站」子树才会内联返回
    assert seen["payload"]["containUrlType"] is False
    assert seen["payload"]["containFileType"] is False
    assert out["tags"][0]["name"] == "SaaS应用"
    assert out["data"][0]["children"][0]["crc"] == "3281598801"


def test_modify_policy_application_real_write_is_confirmed(monkeypatch):
    """netpolicy modify 已登记 CONFIRMED_WRITES：dry_run=False 不应被拦截。"""
    import copy

    c = _client()
    posts: list[dict] = []

    def fake_post(path, payload):
        if payload.get("opr") == "listItem":
            return copy.deepcopy(_POLICY_LISTITEM)
        posts.append(payload)
        return {"success": True}

    monkeypatch.setattr(c, "_post", fake_post)
    result = c.modify_policy_application(
        "fortest", [{"name": "1777345838622622", "action": True, "refs": []}], dry_run=False
    )
    assert result["dry_run"] is False
    assert posts and posts[0]["opr"] == "modify"


def test_policy_move_payloads_match_capture():
    """策略上移/下移报文与真实抓包一致：opr=moveup/movedown，data 含 name 数组与类型。"""
    c = _client()
    up = c.move_policy("fortest_qiuweihao", "up", dry_run=True)
    assert up["payload"] == {
        "opr": "moveup",
        "data": [{"name": ["fortest_qiuweihao"], "type": "访问权限策略"}],
    }
    down = c.move_policy("fortest_qiuweihao", "down", dry_run=True)
    assert down["payload"]["opr"] == "movedown"
    with pytest.raises(SangforWebError):
        c.move_policy("x", "sideways", dry_run=True)


def test_policy_status_payloads_match_capture():
    """批量启用/禁用报文与真实抓包一致：opr=enable/disable，name 为名称数组。"""
    c = _client()
    dis = c.set_policies_status(["fortest_liujieqi", "fortest_qiuweihao"], enabled=False, dry_run=True)
    assert dis["payload"] == {"opr": "disable", "name": ["fortest_liujieqi", "fortest_qiuweihao"]}
    en = c.set_policies_status(["fortest_liujieqi"], enabled=True, dry_run=True)
    assert en["payload"] == {"opr": "enable", "name": ["fortest_liujieqi"]}


def test_url_message_includes_entries_and_keyword():
    """URL 库审计摘要应含具体 URL/IP 条目与关键字，便于直观查看与检索。"""
    from app.services.url_service import _url_message

    msg = _url_message("新增", "test", {"url": "1.1.1.1\nexample.com\n", "keyword": "kw"})
    assert "test" in msg
    assert "1.1.1.1" in msg and "example.com" in msg
    assert "2 条" in msg and "kw" in msg


def test_rule_message_includes_ip_and_domain():
    """自定义应用审计摘要应含 IP 与域名，便于直观查看与检索。"""
    from app.services.customrule_service import _rule_message

    msg = _rule_message("新增", "app1", {"ip_mode": "specified", "ip_range": "10.0.0.1\n10.0.0.2", "domain": "a.com"})
    assert "app1" in msg
    assert "10.0.0.1" in msg and "a.com" in msg


def test_summarize_policy_edit_reports_added_rule():
    """编辑摘要应能识别新增规则并列出动作与引用，便于审计日志直观展示。"""
    from app.services.policy_service import _summarize_policy_edit

    before = {
        "enable": True,
        "depict": "d",
        "application_include": True,
        "rules": [{"rule_id": "100", "action_bool": False, "refs": [{"path": "A"}]}],
    }
    submitted = [
        {"name": "100", "action": False, "refs": [{"path": "A"}]},
        {"name": "200", "action": False, "refs": [{"path": "钉钉"}, {"path": "微信"}]},
    ]
    msg, before_snap, after_snap = _summarize_policy_edit(before, submitted, enable=True, depict="d", include=True)
    assert "新增规则" in msg
    assert "钉钉" in msg and "微信" in msg
    assert len(before_snap["规则"]) == 1
    assert len(after_snap["规则"]) == 2


def test_policy_delete_payload_matches_capture():
    """策略删除报文与真实抓包一致：opr=delete，name 为名称数组。"""
    c = _client()
    res = c.delete_policy("fortest_qiuweihao", dry_run=True)
    assert res["payload"] == {"opr": "delete", "name": ["fortest_qiuweihao"]}
    # 已登记白名单：dry_run=False 不再被拦截（用打桩 _post 验证真正提交 opr=delete）
    posts: list[dict] = []
    c._post = lambda path, payload: (posts.append(payload), {"success": True})[1]  # type: ignore[assignment]
    c.delete_policy("fortest_qiuweihao", dry_run=False)
    assert posts == [{"opr": "delete", "name": ["fortest_qiuweihao"]}]


def test_policy_create_builds_add_data_from_template():
    """新建策略：据默认骨架 + 表单构造 data，规则含生成的 ID 与设备字段。"""
    from app.services import policy_template

    form = {
        "name": "test",
        "depict": "",
        "enable": True,
        "rules": [
            {
                "action": False,
                "refs": [
                    {"path": "DNS/全部", "type": "catagory", "crc": "340434635", "extra": ""},
                    {"path": "访问网站/全部", "type": "catagory", "crc": "3281598801", "extra": "url"},
                ],
            }
        ],
    }
    data = policy_template.build_policy_create_data(form)
    assert data["name"] == "test" and data["type"] == 1 and data["enable"] is True
    # 默认骨架沿用（application 之外的段保留默认值）
    assert "keyword" in data and "saas" in data and "mail" in data
    app_data = data["appctrl"]["application"]["data"]
    assert len(app_data) == 1
    rule = app_data[0]
    assert rule["action"] is False and rule["time"] == "全天" and rule["name"]
    assert rule["apps"]["apps"][0] == {"path": "DNS/全部", "type": "catagory", "crc": "340434635"}
    assert rule["apps"]["apps"][1]["extra"] == "url"
    assert data["appctrl"]["application"]["include"] is True


def test_policy_create_envelope_opr_add():
    """create_policy 应以 opr=add + data 提交。"""
    c = _client()
    res = c.create_policy({"name": "x", "appctrl": {"application": {"data": [], "include": False}}}, dry_run=True)
    assert res["payload"]["opr"] == "add"
    assert res["payload"]["data"]["name"] == "x"


def test_ttl_cache_hit_force_and_invalidate():
    """命中缓存不重算；force / invalidate / 不同 key 触发重算。"""
    from app.services.analysis_cache import TTLCache

    cache = TTLCache(ttl_seconds=60)
    calls = {"n": 0}

    def compute():
        calls["n"] += 1
        return {"v": calls["n"]}

    v1, cached1, _ = cache.get_or_compute("k", compute)
    assert v1 == {"v": 1} and cached1 is False and calls["n"] == 1
    # 窗口内命中：直接返回上次结果、不重算
    v2, cached2, age2 = cache.get_or_compute("k", compute)
    assert v2 == {"v": 1} and cached2 is True and calls["n"] == 1 and age2 >= 0
    # force：强制重算并刷新
    v3, cached3, _ = cache.get_or_compute("k", compute, force=True)
    assert v3 == {"v": 2} and cached3 is False and calls["n"] == 2
    # 失效后重算
    cache.invalidate("k")
    v4, cached4, _ = cache.get_or_compute("k", compute)
    assert v4 == {"v": 3} and cached4 is False and calls["n"] == 3
    # 不同实例 key 互不影响
    cache.get_or_compute("other", compute)
    assert calls["n"] == 4


def test_ttl_cache_zero_ttl_disables_caching():
    """ttl<=0 视为关闭缓存：每次都重算。"""
    from app.services.analysis_cache import TTLCache

    cache = TTLCache(ttl_seconds=0)
    calls = {"n": 0}

    def compute():
        calls["n"] += 1
        return calls["n"]

    cache.get_or_compute("k", compute)
    _, cached, _ = cache.get_or_compute("k", compute)
    assert cached is False and calls["n"] == 2


# --------------------------------------------------------------------------- #
# 策略跨实例同步：crc 重映射引擎
# --------------------------------------------------------------------------- #

def _sample_app_tree():
    """模拟目标设备 listAppTree：含分类、内置应用、自定义应用、访问网站 URL 子类。"""
    return {
        "tags": [],
        "data": [
            {
                "name": "Web流媒体",
                "type": "catagory",
                "children": [
                    {"name": "全部", "type": "app", "value": "Web流媒体/全部", "crc": "T-1001"},
                ],
            },
            {
                "name": "自定义",
                "type": "catagory",
                "children": [
                    {"name": "钉钉应用", "type": "app", "value": "自定义/钉钉应用", "crc": "T-2002"},
                ],
            },
            {
                "name": "访问网站",
                "type": "catagory",
                "children": [
                    {
                        "name": "钉钉白名单",
                        "type": "catagory",
                        "children": [
                            {
                                "name": "网站浏览",
                                "type": "power",
                                "value": "访问网站/钉钉白名单/网站浏览",
                                "crc": "T-3003",
                                "extra": "url",
                            },
                        ],
                    },
                ],
            },
        ],
    }


def test_build_app_index_flattens_tree_with_crc():
    """app 树展平为 path->{crc,type}，递归收集 children 的叶子。"""
    from app.services.policy_sync import build_app_index

    index = build_app_index(_sample_app_tree())
    assert index["Web流媒体/全部"]["crc"] == "T-1001"
    assert index["自定义/钉钉应用"] == {"crc": "T-2002", "type": "app"}
    assert index["访问网站/钉钉白名单/网站浏览"]["crc"] == "T-3003"
    # 仅带 value 的节点入索引（分类节点无 value 不入）
    assert "Web流媒体" not in index


def _source_policy_detail():
    """源策略完整详情：两个引用，crc 为源设备值（应被目标覆盖）。

    ``rules`` 为 get_policy_detail 解析结果，供 build_remapped_rules 重映射 crc。
    """
    return {
        "policy_name": "测试策略",
        "application_include": True,
        "enable": True,
        "depict": "x",
        "rules": [
            {
                "rule_id": "rule-src-1",
                "name": "rule-src-1",
                "action_bool": False,
                "refs": [
                    {"path": "自定义/钉钉应用", "type": "app", "crc": "S-9001", "extra": ""},
                    {"path": "访问网站/钉钉白名单/网站浏览", "type": "power", "crc": "S-9002", "extra": "url"},
                ],
            }
        ],
        "raw": {
            "success": True,  # 信封字段，应被剔除
            "name": "测试策略",
            "enable": True,
            "depict": "x",
            "use_info": {"local": "本地全部用户"},  # 适用对象，应被剔除
            "appctrl": {
                "application": {
                    "include": True,
                    "data": [
                        {
                            "name": "rule-src-1",
                            "action": False,
                            "apps": {
                                "apps": [
                                    {"path": "自定义/钉钉应用", "type": "app", "crc": "S-9001", "extra": ""},
                                    {
                                        "path": "访问网站/钉钉白名单/网站浏览",
                                        "type": "power",
                                        "crc": "S-9002",
                                        "extra": "url",
                                    },
                                ],
                                "tags": [],
                                "extra": [],
                            },
                        }
                    ],
                }
            },
        },
    }


def test_build_remapped_rules_maps_crc_to_target():
    """规则按目标 crc 重映射，保留动作与规则 ID。"""
    from app.services.policy_sync import build_app_index, build_remapped_rules

    index = build_app_index(_sample_app_tree())
    rules, missing = build_remapped_rules(_source_policy_detail(), index)

    assert missing == []
    assert rules[0]["name"] == "rule-src-1"
    assert rules[0]["action"] is False
    crcs = [r["crc"] for r in rules[0]["refs"]]
    assert crcs == ["T-2002", "T-3003"]  # 源 S-9001/S-9002 → 目标 crc


def test_classify_missing_splits_creatable_and_builtin():
    """缺失引用区分可创建（源自定义）与内置缺失（无法创建）。"""
    from app.services.policy_sync import classify_missing

    creatable, builtin = classify_missing(
        ["自定义/钉钉应用", "访问网站/钉钉白名单/网站浏览", "Web流媒体/全部"],
        source_custom_apps={"钉钉应用"},
        source_custom_urls={"钉钉白名单"},
    )
    paths = {c["path"]: c for c in creatable}
    assert paths["自定义/钉钉应用"]["kind"] == "app" and paths["自定义/钉钉应用"]["name"] == "钉钉应用"
    assert paths["访问网站/钉钉白名单/网站浏览"]["kind"] == "url"
    assert builtin == ["Web流媒体/全部"]  # 内置应用无法自动创建


def test_classify_missing_matches_glued_custom_app_prefix():
    """自定义应用名与「自定义」前缀粘连成一段时仍能识别（修复 自定义应用_AIGC应用 漏判）。"""
    from app.services.policy_sync import classify_missing

    creatable, builtin = classify_missing(
        ["自定义应用_AIGC应用/全部", "AI_Agent/全部", "大模型API/全部"],
        source_custom_apps={"AIGC应用"},
        source_custom_urls=set(),
    )
    assert len(creatable) == 1
    assert creatable[0]["kind"] == "app" and creatable[0]["name"] == "AIGC应用"
    # AI_Agent / 大模型API 为内置（未以「自定义」开头、也非源自定义应用）
    assert builtin == ["AI_Agent/全部", "大模型API/全部"]


class _FakeSourceWeb:
    """源设备替身：提供被引用对象的详情供 ensure 复制到目标。"""

    def get_url_group_detail(self, name):
        return {"depict": "d", "url_text": "a.com\nb.com", "keyword": ""}

    def get_custom_rule_detail(self, name):
        return {"summary": {"rulename": name}, "detail": {}}


class _FakeTargetWeb:
    """记录写调用的目标设备替身。``existing_apps`` / ``existing_urls`` 模拟目标已有的同名对象。"""

    def __init__(self, tree, *, has_policy, existing_apps=(), existing_urls=()):
        self._tree = tree
        self._has_policy = has_policy
        self._existing_apps = set(existing_apps)
        self._existing_urls = set(existing_urls)
        self.modify_calls: list = []
        self.create_policy_calls: list = []
        self.created_apps: list = []
        self.updated_apps: list = []
        self.created_urls: list = []
        self.updated_urls: list = []

    def list_app_tree(self):
        return self._tree

    def list_custom_rules(self):
        return [{"rulename": n} for n in self._existing_apps]

    def list_url_groups(self):
        return {"flat": [{"name": n, "inside": ""} for n in self._existing_urls]}

    def create_custom_rule(self, data, *, dry_run=True):
        self.created_apps.append(data)
        return {"dry_run": dry_run, "payload": data}

    def update_custom_rule(self, data, *, dry_run=True):
        self.updated_apps.append(data)
        return {"dry_run": dry_run, "payload": data}

    def create_url_group(self, data, *, dry_run=True):
        self.created_urls.append(data)
        return {"dry_run": dry_run, "payload": data}

    def update_url_group(self, data, *, dry_run=True):
        self.updated_urls.append(data)
        return {"dry_run": dry_run, "payload": data}

    def modify_policy_application(self, name, rules, **kw):
        if getattr(self, "fail_write", False):
            raise SangforWebError("/cgi-bin/netpolicy.cgi（opr=modify）返回失败：设备拒绝")
        self.modify_calls.append((name, rules, kw))
        return {"dry_run": kw.get("dry_run", True), "payload": {"opr": "modify", "name": name}}

    def create_policy(self, data, *, dry_run=True):
        self.create_policy_calls.append((data, dry_run))
        return {"dry_run": dry_run, "payload": {"opr": "add", "data": data}}


def test_sync_policy_modify_uses_proven_contract_when_exists():
    """目标已存在 → 走 modify_policy_application（读目标底座契约），crc 已重映射。"""
    from app.services.policy_sync import sync_policy_to_target

    target = _FakeTargetWeb(_sample_app_tree(), has_policy=True)
    out = sync_policy_to_target(
        source_web=None, target_web=target, source_detail=_source_policy_detail(),
        exists=True, dry_run=True, source_custom_apps=set(), source_custom_urls=set(),
    )
    assert len(target.modify_calls) == 1 and not target.create_policy_calls
    _, rules, _ = target.modify_calls[0]
    assert [r["crc"] for r in rules[0]["refs"]] == ["T-2002", "T-3003"]
    assert out["missing"] == [] and out["created"] == []


def test_sync_policy_add_uses_create_policy_when_absent():
    """目标无此策略 → 走 create_policy（opr=add），用已验证骨架（非源原始对象）+ crc 已重映射。"""
    from app.services.policy_sync import sync_policy_to_target

    target = _FakeTargetWeb(_sample_app_tree(), has_policy=False)
    sync_policy_to_target(
        source_web=None, target_web=target, source_detail=_source_policy_detail(),
        exists=False, dry_run=True, source_custom_apps=set(), source_custom_urls=set(),
    )
    assert len(target.create_policy_calls) == 1 and not target.modify_calls
    data, _ = target.create_policy_calls[0]
    refs = data["appctrl"]["application"]["data"][0]["apps"]["apps"]
    assert [r["crc"] for r in refs] == ["T-2002", "T-3003"]
    # 用 policy_template 骨架：带骨架默认字段、规则 ID 由模板生成（不是源 rule_id）
    assert data["type"] == 1 and "samerole" in data and data["name"] == "测试策略"
    assert data["appctrl"]["application"]["data"][0]["name"] != "rule-src-1"
    assert data["appctrl"]["application"]["data"][0]["time"] == "全天"


def test_sync_policy_dry_run_previews_autocreate_without_blocking():
    """dry-run：目标缺自定义引用时预告将创建、不阻断；内置缺失列入 missing。"""
    from app.services.policy_sync import sync_policy_to_target

    # 目标树缺「自定义/钉钉应用」与内置「Web流媒体/全部」，仅有访问网站
    partial_tree = {
        "data": [
            {
                "name": "访问网站",
                "type": "catagory",
                "children": [
                    {
                        "name": "钉钉白名单",
                        "type": "catagory",
                        "children": [
                            {
                                "name": "网站浏览",
                                "type": "power",
                                "value": "访问网站/钉钉白名单/网站浏览",
                                "crc": "T-3003",
                                "extra": "url",
                            },
                        ],
                    }
                ],
            }
        ]
    }
    target = _FakeTargetWeb(partial_tree, has_policy=True)  # 目标无同名应用 → 将创建
    out = sync_policy_to_target(
        source_web=_FakeSourceWeb(), target_web=target, source_detail=_source_policy_detail(),
        exists=True, dry_run=True,
        source_custom_apps={"钉钉应用"}, source_custom_urls={"钉钉白名单"},
    )
    assert out["created"] == ["钉钉应用"]  # 源自定义应用 → 预告将创建（按名）
    assert out["missing"] == []  # 钉钉应用可创建、访问网站已存在，无硬缺失
    assert any("将创建自定义应用「钉钉应用」" in d for d in out["details"])


def test_sync_policy_updates_existing_referenced_object_not_add():
    """目标已有同名被引用对象 → 走 update（改成一致），不走 add（不再报「名字已被使用」）。"""
    from app.services.policy_sync import sync_policy_to_target

    partial_tree = {
        "data": [
            {"name": "访问网站", "type": "catagory", "children": [
                {"name": "钉钉白名单", "type": "catagory", "children": [
                    {"name": "网站浏览", "type": "power", "value": "访问网站/钉钉白名单/网站浏览",
                     "crc": "T-3003", "extra": "url"}]}]},
        ]
    }
    # 目标已存在同名自定义应用「钉钉应用」
    target = _FakeTargetWeb(partial_tree, has_policy=True, existing_apps={"钉钉应用"})
    out = sync_policy_to_target(
        source_web=_FakeSourceWeb(), target_web=target, source_detail=_source_policy_detail(),
        exists=True, dry_run=False,
        source_custom_apps={"钉钉应用"}, source_custom_urls={"钉钉白名单"},
    )
    assert target.updated_apps and not target.created_apps  # 走更新而非新增
    assert any("已更新自定义应用「钉钉应用」（目标已存在" in d for d in out["details"])


def test_ensure_referenced_objects_dedupes_by_name():
    """同一对象被多个引用路径命中只处理一次（避免重复 add）。"""
    from app.services.policy_sync import ensure_referenced_objects

    target = _FakeTargetWeb(_sample_app_tree(), has_policy=True)
    creatable = [
        {"path": "访问网站/钉钉白名单/网站浏览", "kind": "url", "name": "钉钉白名单"},
        {"path": "访问网站/钉钉白名单/文件上传", "kind": "url", "name": "钉钉白名单"},
        {"path": "访问网站/钉钉白名单/HTTPS", "kind": "url", "name": "钉钉白名单"},
    ]
    created, updated, failed = ensure_referenced_objects(
        _FakeSourceWeb(), target, creatable, dry_run=False
    )
    assert len(target.created_urls) == 1  # 三个路径同名 → 只建一次
    assert len(created) == 1 and not updated and not failed


def test_sync_policy_real_write_skips_builtin_missing():
    """允许降级（allow_degrade=True）：内置缺失引用被跳过、策略照常写入、标 degraded，跳过项计入 missing。"""
    from app.services.policy_sync import sync_policy_to_target

    # 目标缺内置「Web流媒体/全部」，源详情额外引用它
    detail = _source_policy_detail()
    detail["rules"][0]["refs"].append({"path": "Web流媒体/全部", "type": "app", "crc": "S-1", "extra": ""})
    partial_tree = {
        "data": [
            {"name": "自定义", "type": "catagory", "children": [
                {"name": "钉钉应用", "type": "app", "value": "自定义/钉钉应用", "crc": "T-2002"}]},
            {"name": "访问网站", "type": "catagory", "children": [
                {"name": "钉钉白名单", "type": "catagory", "children": [
                    {"name": "网站浏览", "type": "power", "value": "访问网站/钉钉白名单/网站浏览",
                     "crc": "T-3003", "extra": "url"}]}]},
        ]
    }
    target = _FakeTargetWeb(partial_tree, has_policy=True)
    out = sync_policy_to_target(
        source_web=None, target_web=target, source_detail=detail,
        exists=True, dry_run=False, source_custom_apps=set(), source_custom_urls=set(),
        allow_degrade=True,
    )
    # 允许降级后照常写入，内置缺失引用被丢弃、标 degraded、计入 missing
    assert out["ok"] is True and out["degraded"] is True
    assert len(target.modify_calls) == 1
    _, rules, _ = target.modify_calls[0]
    ref_paths = {r["path"] for r in rules[0]["refs"]}
    assert "Web流媒体/全部" not in ref_paths  # 被跳过
    assert "自定义/钉钉应用" in ref_paths and "访问网站/钉钉白名单/网站浏览" in ref_paths  # 其余照常
    assert out["missing"] == ["Web流媒体/全部"]


def test_sync_policy_write_failure_returns_ok_false_with_details():
    """写策略失败：不抛异常，以 ok=False + 逐步详情返回，含设备返回的 path/opr/原因。"""
    from app.services.policy_sync import sync_policy_to_target

    target = _FakeTargetWeb(_sample_app_tree(), has_policy=True)
    target.fail_write = True
    out = sync_policy_to_target(
        source_web=None, target_web=target, source_detail=_source_policy_detail(),
        exists=True, dry_run=False, source_custom_apps=set(), source_custom_urls=set(),
    )
    assert out["ok"] is False
    assert any("更新策略：失败" in d for d in out["details"])
    assert any("netpolicy.cgi" in d for d in out["details"])  # 详情含具体接口与原因


def test_post_failure_message_includes_path_opr_and_response(monkeypatch):
    """设备 success=false 且无 msg：错误带 path / opr 与响应片段，而非干巴巴「接口返回失败」。"""
    c = SangforWebClient("https", "h", 443, "u", "p")
    c._logged_in = True

    class _Resp:
        status_code = 200
        text = ""
        apparent_encoding = "utf-8"
        encoding = "utf-8"

        def json(self):
            return {"success": False, "errcode": 7}  # 无 msg

    monkeypatch.setattr(c.session, "post", lambda *a, **k: _Resp())
    with pytest.raises(SangforWebError) as ei:
        c._post("/cgi-bin/netpolicy.cgi", {"opr": "modify"})
    msg = str(ei.value)
    assert "netpolicy.cgi" in msg and "opr=modify" in msg and "errcode" in msg


# --------------------------------------------------------------------------- #
# 全局搜索：智能匹配（域名通配/子域 + IP 网段/范围）
# --------------------------------------------------------------------------- #

def test_search_domain_wildcard_and_subdomain_matching():
    """域名智能匹配：通配符、子域双向归属，且不误命中相似域。"""
    from app.services.search_service import _domain_match

    # 通配符条目命中查询的具体子域
    assert _domain_match("*.deepin.org", "www.deepin.org")
    assert _domain_match("*.deepin.org", "deepin.org")
    # 精确条目：查询子域命中父域条目；查询父域命中子域条目（双向）
    assert _domain_match("deepin.org", "www.deepin.org")
    assert _domain_match("a.deepin.org", "deepin.org")
    # 协议头 / 路径会被规范化
    assert _domain_match("https://www.unitree.com/foo", "unitree.com")
    # 不同域不应误命中（标签边界）
    assert not _domain_match("notdeepin.org", "deepin.org")
    assert not _domain_match("deepin.org", "deepin.com")


def test_search_ip_cidr_and_range_matching():
    """IP 智能匹配：单 IP / CIDR 网段 / a-b 范围的区间重叠。"""
    from app.services.search_service import _ip_overlaps, looks_like_ip

    assert looks_like_ip("10.0.0.1") and looks_like_ip("10.0.0.0/24") and looks_like_ip("10.0.0.1-10.0.0.9")
    assert not looks_like_ip("www.deepin.org")
    # 查询单 IP 命中包含它的网段 / 范围
    assert _ip_overlaps("10.0.0.0/24", "10.0.0.7")
    assert _ip_overlaps("10.0.0.1-10.0.0.9", "10.0.0.5")
    # 反向：查询网段命中其中的单 IP 条目
    assert _ip_overlaps("10.0.0.7", "10.0.0.0/24")
    # 不相交
    assert not _ip_overlaps("10.0.1.0/24", "10.0.0.7")


def test_search_over_index_groups_apps_and_url_libraries():
    """search() 在索引上按类型分组返回命中（应用 / 自定义URL / 内置URL）。"""
    from app.services import search_service

    index = {
        "apps": [
            {"name": "AIGC应用", "ips": ["42.62.43.219"], "domains": ["api.openai.com"]},
            {"name": "其他应用", "ips": [], "domains": ["example.com"]},
        ],
        "urls": [
            {"name": "IT相关", "inside": True, "entries": ["*.deepin.org", "www.unitree.com"]},
            {"name": "我的白名单", "inside": False, "entries": ["10.0.0.0/24"]},
        ],
        "errors": [],
    }
    # 注入缓存，避免真实建索引
    search_service.search_cache.invalidate(9999)
    search_service.search_cache._store[9999] = (__import__("time").monotonic(), index)

    class _Inst:
        id = 9999

    # 域名查询：命中内置 URL 库的通配条目
    r = search_service.search(_Inst(), "a.deepin.org")
    assert r["query_type"] == "domain"
    assert [h["name"] for h in r["builtin_urls"]] == ["IT相关"]
    assert r["builtin_urls"][0]["matches"] == ["*.deepin.org"]
    assert not r["apps"] and not r["custom_urls"]

    # IP 查询：命中自定义 URL 库网段 + 应用 IP
    r2 = search_service.search(_Inst(), "10.0.0.9")
    assert r2["query_type"] == "ip"
    assert [h["name"] for h in r2["custom_urls"]] == ["我的白名单"]

    r3 = search_service.search(_Inst(), "42.62.43.219")
    assert [h["name"] for h in r3["apps"]] == ["AIGC应用"]


# --------------------------------------------------------------------------- #
# 批量同步：全量 upsert + 镜像删除
# --------------------------------------------------------------------------- #

class _BatchWeb:
    """目标/源设备替身：按名单列对象、记录删除调用。"""

    def __init__(self, names):
        self._names = list(names)
        self.deleted: list[str] = []

    def list_custom_rules(self):
        return [{"rulename": n} for n in self._names]

    def delete_custom_rule(self, name, *, dry_run=True):
        self.deleted.append(name)
        return {"dry_run": dry_run}


def _setup_batch(monkeypatch, source_names, target_names):
    from app.services import sync_service

    source_web, target_web = _BatchWeb(source_names), _BatchWeb(target_names)

    class _Inst:
        def __init__(self, i, n):
            self.id, self.name = i, n

    insts = {1: _Inst(1, "源"), 2: _Inst(2, "目标")}
    webs = {1: source_web, 2: target_web}
    monkeypatch.setattr(sync_service.instance_service, "get_instance", lambda db, i: insts.get(i))
    monkeypatch.setattr(sync_service.session_pool, "get_web_client", lambda inst: webs[inst.id])
    # 隔离写内部：upsert 决策（create/update/delete）才是本测试关注点
    monkeypatch.setattr(sync_service, "_build_snapshot", lambda web, ot, name: ("found", {"name": name}, ""))
    monkeypatch.setattr(sync_service, "_write_to_target", lambda *a, **k: {"dry_run": a[4]})
    monkeypatch.setattr(sync_service, "invalidate_instance", lambda i: None)
    monkeypatch.setattr(sync_service.audit, "record", lambda *a, **k: None)
    return sync_service, target_web


def test_batch_sync_upsert_splits_create_and_update(monkeypatch):
    """源有目标无 → 新增；两边都有 → 更新；不开镜像不删除。"""
    sync_service, target_web = _setup_batch(monkeypatch, ["a", "b", "c"], ["b", "c", "d"])
    user = type("U", (), {"username": "admin"})()
    res = sync_service.batch_sync(
        db=None, user=user, object_type="customrule", source_instance_id=1,
        target_instance_ids=[2], push_all=False, mirror=False, dry_run=True,
    )
    assert res.source_count == 3
    t = res.targets[0]
    assert set(t.created) == {"a"} and set(t.updated) == {"b", "c"}
    assert t.deleted == [] and target_web.deleted == []  # 未开镜像，不删 d


def test_batch_sync_mirror_deletes_extra_target_objects(monkeypatch):
    """镜像模式：删除目标上「源没有」的对象（d）。"""
    sync_service, target_web = _setup_batch(monkeypatch, ["a", "b"], ["b", "c", "d"])
    user = type("U", (), {"username": "admin"})()
    res = sync_service.batch_sync(
        db=None, user=user, object_type="customrule", source_instance_id=1,
        target_instance_ids=[2], push_all=False, mirror=True, dry_run=False,
    )
    t = res.targets[0]
    assert set(t.created) == {"a"} and set(t.updated) == {"b"}
    assert set(t.deleted) == {"c", "d"}  # 源没有的被镜像删除
    assert set(target_web.deleted) == {"c", "d"}  # 真实调用了删除接口


class _PolicyMirrorWeb:
    """策略镜像测试替身：按名单列策略、记录删除调用与删前快照读取。"""

    def __init__(self, names):
        self._names = list(names)
        self.deleted: list[str] = []
        self.snapshot_reads: list[str] = []

    def list_policies(self):
        return {"access_policies": [{"name": n} for n in self._names]}

    def list_custom_rules(self):
        return []

    def list_url_groups(self):
        return {"flat": []}

    def list_app_tree(self):
        return {"data": []}

    def get_policy_detail(self, name):
        self.snapshot_reads.append(name)
        return {"policy_name": name}

    def delete_policy(self, name, *, dry_run=True):
        self.deleted.append(name)
        return {"dry_run": dry_run}


def _setup_policy_mirror(monkeypatch, usage_result):
    """源 ["a"] / 目标 ["a", "x", "y"]，镜像多余对象为 x、y；引用校验结果由入参指定。"""
    from app.services import sync_service

    source_web, target_web = _PolicyMirrorWeb(["a"]), _PolicyMirrorWeb(["a", "x", "y"])

    class _Inst:
        def __init__(self, i, n):
            self.id, self.name = i, n

    insts = {1: _Inst(1, "源"), 2: _Inst(2, "目标")}
    webs = {1: source_web, 2: target_web}
    monkeypatch.setattr(sync_service.instance_service, "get_instance", lambda db, i: insts.get(i))
    monkeypatch.setattr(sync_service.session_pool, "get_web_client", lambda inst: webs[inst.id])
    monkeypatch.setattr(sync_service, "_write_to_target", lambda *a, **k: {"dry_run": False})
    monkeypatch.setattr(sync_service, "invalidate_instance", lambda i: None)
    monkeypatch.setattr(sync_service.audit, "record", lambda *a, **k: None)
    monkeypatch.setattr(
        sync_service.policy_usage_service, "analyze_policy_usage", lambda inst, force=False: usage_result
    )
    return sync_service, target_web


def test_batch_sync_mirror_policy_skips_in_use_and_reads_snapshot(monkeypatch):
    """策略镜像删除安全闸：在用策略（x）跳过不删；未用策略（y）删除前读删前快照。"""
    usage = {"errors": [], "policies": [
        {"name": "x", "user_count": 3, "used": True},
        {"name": "y", "user_count": 0, "used": False},
    ]}
    sync_service, target_web = _setup_policy_mirror(monkeypatch, usage)
    user = type("U", (), {"username": "admin"})()
    res = sync_service.batch_sync(
        db=None, user=user, object_type="policy", source_instance_id=1,
        target_instance_ids=[2], push_all=False, mirror=True, dry_run=False,
    )
    t = res.targets[0]
    assert target_web.deleted == ["y"] and t.deleted == ["y"]  # 在用的 x 未删
    assert not t.failed
    skips = [d for d in t.details if d.action == "skip"]
    assert len(skips) == 1 and skips[0].name == "x" and "3 个用户引用" in skips[0].message
    assert "y" in target_web.snapshot_reads  # 删除前读取了完整详情作审计快照


def test_batch_sync_mirror_policy_blocks_when_name_missing_from_usage_result(monkeypatch):
    """引用校验成功但结果里没有某个策略名（如与镜像名单间的时间差/固件解析差异）：
    不当作 0 引用直接删——为安全按「无法确认」拒绝，只有确实在结果里且 user_count=0 的才删。"""
    usage = {"errors": [], "policies": [{"name": "y", "user_count": 0, "used": False}]}  # 缺 x
    sync_service, target_web = _setup_policy_mirror(monkeypatch, usage)
    user = type("U", (), {"username": "admin"})()
    res = sync_service.batch_sync(
        db=None, user=user, object_type="policy", source_instance_id=1,
        target_instance_ids=[2], push_all=False, mirror=True, dry_run=False,
    )
    t = res.targets[0]
    assert target_web.deleted == ["y"] and t.deleted == ["y"]  # y 在结果里且未用，正常删除
    assert {f.name for f in t.failed} == {"x"}  # x 不在结果里，按无法确认拒绝，不当 0 引用删
    assert "无法确认" in t.failed[0].message


def test_batch_sync_mirror_policy_blocks_when_usage_check_fails(monkeypatch):
    """引用校验失败（部分组读不到）时无法确认在用与否，该目标的策略镜像删除全部拒绝。"""
    sync_service, target_web = _setup_policy_mirror(
        monkeypatch, {"errors": ["组A: 读取失败"], "policies": []}
    )
    user = type("U", (), {"username": "admin"})()
    res = sync_service.batch_sync(
        db=None, user=user, object_type="policy", source_instance_id=1,
        target_instance_ids=[2], push_all=False, mirror=True, dry_run=False,
    )
    t = res.targets[0]
    assert target_web.deleted == [] and t.deleted == []
    assert {f.name for f in t.failed} == {"x", "y"}
    assert all("引用校验失败" in f.message for f in t.failed)


# --------------------------------------------------------------------------- #
# 策略同步：降级（引用缺失被丢弃）的拒绝 / 允许 / 预览
# --------------------------------------------------------------------------- #

class _DegradeTgt:
    """目标设备替身：空应用树（引用全缺失），记录是否真的写了策略。"""

    def __init__(self):
        self.written = []

    def list_app_tree(self):
        return {"data": []}  # 空树 → 源引用在目标都解析不到

    def modify_policy_application(self, name, rules, **kw):
        self.written.append(("modify", rules))
        return {"dry_run": kw.get("dry_run", False)}

    def create_policy(self, data, dry_run=False):
        self.written.append(("create", data))
        return {"dry_run": dry_run}


_DEGRADE_SRC = {
    "policy_name": "P", "application_include": True, "enable": True, "depict": "",
    "rules": [{"rule_id": "1", "action_bool": False,
               "refs": [{"path": "内置/某拒绝对象", "type": "app", "crc": "9", "extra": ""}]}],
}


def _sync_degrade(tgt, *, dry_run, allow_degrade):
    from app.services import policy_sync
    return policy_sync.sync_policy_to_target(
        None, tgt, _DEGRADE_SRC, exists=True, dry_run=dry_run,
        source_custom_apps=set(), source_custom_urls=set(), allow_degrade=allow_degrade,
    )


def test_sync_policy_refuses_degrade_by_default():
    """乙：真实写入 + 未允许降级 → 拒绝、不写设备。"""
    tgt = _DegradeTgt()
    out = _sync_degrade(tgt, dry_run=False, allow_degrade=False)
    assert out["ok"] is False and out["refused"] is True and out["degraded"] is True
    assert tgt.written == []  # 没有真的写策略


def test_sync_policy_writes_degraded_when_allowed():
    """允许降级 → 写入降级版本、标 degraded。"""
    tgt = _DegradeTgt()
    out = _sync_degrade(tgt, dry_run=False, allow_degrade=True)
    assert out["ok"] is True and out["degraded"] is True and out["refused"] is False
    assert len(tgt.written) == 1  # 真的写了（降级版）


def test_sync_policy_dryrun_previews_degrade_without_refusing():
    """dry-run 始终预览降级、不拦截。"""
    tgt = _DegradeTgt()
    out = _sync_degrade(tgt, dry_run=True, allow_degrade=False)
    assert out["degraded"] is True and out["refused"] is False and out["ok"] is True


def test_sync_policy_refuse_does_not_create_referenced_objects():
    """codex #1 修正：真实写入被拒绝（降级未允许）时，**连可创建的自定义引用对象也不建**、不改设备。"""
    from app.services.policy_sync import sync_policy_to_target

    detail = _source_policy_detail()
    # 额外引用一个目标缺失的**内置**对象 → 会触发降级
    detail["rules"][0]["refs"].append({"path": "Web流媒体/全部", "type": "app", "crc": "S-1", "extra": ""})
    # 目标空树：钉钉应用/白名单（可创建）与 Web流媒体/全部（内置、不可创建）都缺失
    target = _FakeTargetWeb({"data": []}, has_policy=True)
    out = sync_policy_to_target(
        source_web=_FakeSourceWeb(), target_web=target, source_detail=detail,
        exists=True, dry_run=False,
        source_custom_apps={"钉钉应用"}, source_custom_urls={"钉钉白名单"}, allow_degrade=False,
    )
    assert out["refused"] is True and out["ok"] is False and out["created"] == []
    # 关键：拒绝发生在创建之前——自定义引用对象没被写进设备，策略本身也没写
    assert target.created_apps == [] and target.created_urls == []
    assert target.updated_apps == [] and target.updated_urls == []
    assert target.modify_calls == []


def test_sync_policy_refuses_when_custom_ref_create_fails():
    """codex 姊妹 bug：自定义引用**创建失败**导致引用缺失时，真实写入默认拒绝、不写出缺引用的降级策略。"""
    from app.services.policy_sync import sync_policy_to_target

    class _FailUrlCreate(_FakeTargetWeb):
        def create_url_group(self, data, *, dry_run=True):
            raise SangforWebError("创建 URL 库失败：设备拒绝")

    # 源仅引用一个自定义 URL「钉钉白名单」；目标空树需创建，而创建会失败
    detail = {
        "policy_name": "外网白名单", "application_include": True, "enable": True, "depict": "",
        "rules": [{"rule_id": "1", "name": "1", "action_bool": True,
                   "refs": [{"path": "访问网站/钉钉白名单/网站浏览", "type": "power", "crc": "S-1", "extra": "url"}]}],
    }
    target = _FailUrlCreate({"data": []}, has_policy=True)
    out = sync_policy_to_target(
        source_web=_FakeSourceWeb(), target_web=target, source_detail=detail,
        exists=True, dry_run=False,
        source_custom_apps=set(), source_custom_urls={"钉钉白名单"}, allow_degrade=False,
    )
    assert out["refused"] is True and out["ok"] is False
    assert target.modify_calls == []  # 创建失败 → 策略没写
    assert any("失败" in d for d in out["details"])


# --------------------------------------------------------------------------- #
# 全量对比：四分类 + 策略按内容（忽略 rule_id）判定
# --------------------------------------------------------------------------- #

def _setup_compare(monkeypatch, src_index, tgt_index):
    from app.services import compare_service

    class _Inst:
        def __init__(self, i, n):
            self.id, self.name = i, n

    insts = {1: _Inst(1, "源"), 2: _Inst(2, "目标")}
    idx = {1: src_index, 2: tgt_index}
    monkeypatch.setattr(compare_service.instance_service, "get_instance", lambda db, i: insts.get(i))
    monkeypatch.setattr(compare_service, "_index", lambda inst, ot, *, force=False: (idx[inst.id], False, 0))
    return compare_service


def test_compare_classifies_four_buckets(monkeypatch):
    """仅源有 / 仅目标有 / 内容一致 / 内容不一致 四类正确归位。"""
    src_index = {"names": ["a", "b", "c"], "snaps": {
        "a": ("found", {"name": "a", "url": "x"}, ""),
        "b": ("found", {"name": "b", "url": "same"}, ""),
        "c": ("found", {"name": "c", "url": "src"}, ""),
    }}
    tgt_index = {"names": ["b", "c", "d"], "snaps": {
        "b": ("found", {"name": "b", "url": "same"}, ""),
        "c": ("found", {"name": "c", "url": "tgt"}, ""),
        "d": ("found", {"name": "d", "url": "z"}, ""),
    }}
    compare_service = _setup_compare(monkeypatch, src_index, tgt_index)
    res = compare_service.compare(db=None, object_type="url", source_instance_id=1, target_instance_ids=[2])
    t = res.targets[0]
    assert (t.source_only, t.target_only, t.identical, t.different) == (1, 1, 1, 1)
    by = {it.name: it.status for it in t.items}
    assert by == {"a": "source_only", "b": "identical", "c": "different", "d": "target_only"}
    c = next(it for it in t.items if it.name == "c")
    assert c.source_snapshot == {"name": "c", "url": "src"} and c.diffs  # 不一致带源快照 + 字段差异
    # identical 精简报文：不带快照
    assert next(it for it in t.items if it.name == "b").source_snapshot is None


def test_compare_names_only_three_buckets(monkeypatch):
    """仅名单对比：只按名字分「仅源有 / 仅目标有 / 两边都有」，不拉详情。"""
    from app.services import compare_service

    class _Inst:
        def __init__(self, i, n):
            self.id, self.name = i, n

    insts = {1: _Inst(1, "源"), 2: _Inst(2, "目标")}
    monkeypatch.setattr(compare_service.instance_service, "get_instance", lambda db, i: insts.get(i))
    names = {1: ["a", "b", "c"], 2: ["b", "c", "d"]}
    monkeypatch.setattr(compare_service, "_list_names", lambda inst, ot: names[inst.id])
    # 若误走内容路径会调用 _index（拉详情），这里让它报错以确保没走
    monkeypatch.setattr(compare_service, "_index", lambda *a, **k: (_ for _ in ()).throw(AssertionError("不应拉详情")))

    res = compare_service.compare(
        db=None, object_type="url", source_instance_id=1, target_instance_ids=[2], names_only=True
    )
    assert res.names_only is True
    t = res.targets[0]
    assert (t.source_only, t.target_only, t.both) == (1, 1, 2)
    by = {it.name: it.status for it in t.items}
    assert by == {"a": "source_only", "b": "both", "c": "both", "d": "target_only"}


def _pol(name, rules, *, enable=True, app_inc=True, net_inc=False, net_rules=None, proxy_inc=False, proxy=None):
    """构造一条策略快照（默认只启用应用控制），供对比测试用。"""
    return {
        "policy_name": name, "enable": enable, "application_include": app_inc, "rules": rules,
        "network_include": net_inc, "network_rules": net_rules or [],
        "proxy_include": proxy_inc, "proxy": proxy or {"http": False, "sock": False, "errorproto": False},
    }


def test_compare_policy_uses_content_not_rule_id(monkeypatch):
    """策略：rule_id 跨实例不同但引用应用/URL 相同 → 判「一致」；引用不同 → 判「不一致」。"""
    src_index = {"names": ["P", "Q"], "snaps": {
        "P": ("found", _pol("P", [{"name": "111", "action": "allow", "apps": [{"path": "A"}], "urls": []}]), ""),
        "Q": ("found", _pol("Q", [{"name": "1", "action": "allow", "apps": [{"path": "A"}], "urls": []}]), ""),
    }}
    tgt_index = {"names": ["P", "Q"], "snaps": {
        "P": ("found", _pol("P", [{"name": "999", "action": "allow", "apps": [{"path": "A"}], "urls": []}]), ""),
        "Q": ("found", _pol("Q", [{"name": "2", "action": "allow", "apps": [{"path": "B"}], "urls": []}]), ""),
    }}
    compare_service = _setup_compare(monkeypatch, src_index, tgt_index)
    res = compare_service.compare(db=None, object_type="policy", source_instance_id=1, target_instance_ids=[2])
    by = {it.name: it for it in res.targets[0].items}
    assert by["P"].status == "identical"  # rule_id 不同但内容相同
    assert by["Q"].status == "different"  # 引用应用 A vs B


def test_compare_policy_detects_action_enable_network(monkeypatch):
    """扩展对比：同引用但动作相反 / 被禁用 / 端口控制不同 → 都判「不一致」。"""
    base = [{"name": "1", "action": "allow", "apps": [{"path": "A"}], "urls": []}]
    src_index = {"names": ["ACT", "EN", "NET", "SAME"], "snaps": {
        "ACT": ("found", _pol("ACT", base), ""),
        "EN": ("found", _pol("EN", base), ""),
        "NET": ("found", _pol("NET", base, net_inc=True,
                              net_rules=[{"dip": "黑名单", "service": "All", "action": 0, "time": "全天"}]), ""),
        "SAME": ("found", _pol("SAME", base), ""),
    }}
    tgt_index = {"names": ["ACT", "EN", "NET", "SAME"], "snaps": {
        # 同引用但动作 allow→deny
        "ACT": ("found", _pol("ACT", [{"name": "9", "action": "deny", "apps": [{"path": "A"}], "urls": []}]), ""),
        # 同引用但整条被禁用
        "EN": ("found", _pol("EN", base, enable=False), ""),
        # 端口控制规则不同
        "NET": ("found", _pol("NET", base, net_inc=True,
                              net_rules=[{"dip": "白名单", "service": "All", "action": 1, "time": "全天"}]), ""),
        # 完全一致（仅 rule_id 不同）
        "SAME": ("found", _pol("SAME", [{"name": "77", "action": "allow", "apps": [{"path": "A"}], "urls": []}]), ""),
    }}
    compare_service = _setup_compare(monkeypatch, src_index, tgt_index)
    res = compare_service.compare(db=None, object_type="policy", source_instance_id=1, target_instance_ids=[2])
    by = {it.name: it.status for it in res.targets[0].items}
    assert by["ACT"] == "different"   # 动作相反
    assert by["EN"] == "different"    # 启用状态不同
    assert by["NET"] == "different"   # 端口控制不同
    assert by["SAME"] == "identical"  # 真一致


# --------------------------------------------------------------------------- #
# 旧固件（acnetpolicy.cgi）策略写：ssl 段补齐 + 白名单
# --------------------------------------------------------------------------- #

def test_create_policy_injects_ssl_for_old_firmware():
    """旧固件（acnetpolicy.cgi）新建策略：自动把空 ssl 补齐为完整默认结构。"""
    c = _client()
    c._policy_cgi_detected = True  # 跳过路径探测
    c.NETPOLICY_CGI = c.ACNETPOLICY_CGI  # 模拟已探测为旧固件
    out = c.create_policy(
        {"name": "test222", "ssl": {}, "appctrl": {"application": {"data": [], "include": True}}},
        dry_run=True,
    )
    body = out["payload"]
    assert body["opr"] == "add"
    sslident = body["data"]["ssl"]["sslident"]
    assert sslident["include"] is False and "web" in sslident and "mail" in sslident


def test_create_policy_keeps_empty_ssl_for_new_firmware():
    """新固件（netpolicy.cgi）新建策略：ssl 保持 {}，不注入。"""
    c = _client()
    c._policy_cgi_detected = True  # 默认 netpolicy.cgi
    out = c.create_policy(
        {"name": "p", "ssl": {}, "appctrl": {"application": {"data": [], "include": True}}},
        dry_run=True,
    )
    assert out["payload"]["data"]["ssl"] == {}


def test_acnetpolicy_writes_are_confirmed():
    """旧固件 acnetpolicy.cgi 的 add/modify 已登记到写白名单。"""
    from app.sangfor.web_base import CONFIRMED_WRITES

    assert ("/cgi-bin/acnetpolicy.cgi", "add") in CONFIRMED_WRITES
    assert ("/cgi-bin/acnetpolicy.cgi", "modify") in CONFIRMED_WRITES


# --------------------------------------------------------------------------- #
# 组织 / 用户 CGI + 策略引用校验
# --------------------------------------------------------------------------- #

def test_list_org_tree_flattens_all_nodes(monkeypatch):
    """listorgtree 嵌套树展平为所有组节点（含根、子组）。"""
    c = _client()
    tree = {
        "success": True,
        "data": {
            "text": "/", "id": "root", "leaf": False,
            "children": [
                {"text": "非个人电脑", "id": "g1", "leaf": False, "children": [
                    {"text": "服务器", "id": "g1a", "leaf": True},
                ]},
                {"text": "default", "id": "g2", "leaf": True},
            ],
        },
    }
    monkeypatch.setattr(c, "_post", lambda path, body: tree)
    nodes = c.list_org_tree()
    ids = {n["id"] for n in nodes}
    assert ids == {"root", "g1", "g1a", "g2"}


def test_list_org_members_splits_users_and_subgroups(monkeypatch):
    """listItem 返回的行里 org:true 为子组（带策略），org:false 为用户；分别归类返回。"""
    c = _client()
    resp = {
        "data": [
            {"org": True, "id": "sub1", "name": "子组A", "strategy": "组默认策略,公司基础白名单"},
            {"org": False, "name": "userA", "strategy": "公司基础白名单,上网审计策略", "status": True},
            {"org": False, "name": "userB", "strategy": "没有策略", "status": True},
        ],
        "count": 3,
        "success": True,
    }
    monkeypatch.setattr(c, "_post", lambda path, body: resp)
    out = c.list_org_members("g1")
    assert [u["name"] for u in out["users"]] == ["userA", "userB"]
    assert out["users"][0]["strategy"] == "公司基础白名单,上网审计策略"
    # 子组行单独归类，带 id 与该组的生效策略（供展开用户的「继承占位」）
    assert out["subgroups"] == [{"id": "sub1", "name": "子组A", "strategy": "组默认策略,公司基础白名单"}]


def test_analyze_policy_usage_counts_users_and_flags_unused(monkeypatch):
    """策略引用校验：按用户 strategy 并集计数，无人引用的标 used=False。"""
    from app.services import policy_usage_service

    class _FakeWeb:
        def login(self):
            pass

        def clone_session(self):
            return self

        def list_policies(self):
            return {
                "access_policies": [
                    {"name": "公司基础白名单", "order": 1, "status": True, "depict": "", "founder": "admin"},
                    {"name": "没人用的白名单", "order": 2, "status": True, "depict": "", "founder": "admin"},
                ]
            }

        def list_org_tree(self):
            return [{"id": "g1", "name": "组1"}]

        def list_org_members(self, org_id, **kw):
            return {
                "users": [
                    {"name": "u1", "strategy": "公司基础白名单,上网审计策略", "status": True},
                    {"name": "u2", "strategy": "公司基础白名单", "status": True},
                    {"name": "u3", "strategy": "没有策略", "status": True},
                ],
                "subgroups": [],
            }

    fake = _FakeWeb()
    monkeypatch.setattr(policy_usage_service.session_pool, "get_web_client", lambda inst: fake)
    policy_usage_service.policy_usage_cache.invalidate(777)

    class _Inst:
        id = 777

    out = policy_usage_service.analyze_policy_usage(_Inst())
    by_name = {p["name"]: p for p in out["policies"]}
    assert by_name["公司基础白名单"]["user_count"] == 2 and by_name["公司基础白名单"]["used"] is True
    assert by_name["没人用的白名单"]["user_count"] == 0 and by_name["没人用的白名单"]["used"] is False
    assert out["unused_count"] == 1 and out["total_users"] == 3
    # 无人引用的排在前面（醒目）
    assert out["policies"][0]["name"] == "没人用的白名单"


def test_analyze_policy_usage_expands_inherited_group_strategy(monkeypatch):
    """深圳式继承：用户行 strategy 为占位符「与所属组相同」时，用所属组的策略展开计数，
    不再把整组继承的策略误报为无人引用。"""
    from app.services import policy_usage_service

    class _FakeWeb:
        def login(self):
            pass

        def clone_session(self):
            return self

        def list_policies(self):
            return {
                "access_policies": [
                    {"name": "自研虚拟桌面外网白名单", "order": 1, "status": True, "depict": "", "founder": "admin"},
                    {"name": "公司基础白名单", "order": 2, "status": True, "depict": "", "founder": "admin"},
                    {"name": "真没人用", "order": 3, "status": True, "depict": "", "founder": "admin"},
                ]
            }

        def list_org_tree(self):
            # 父组 P（含子组 L 的行）与叶子组 L（含继承占位的用户）
            return [{"id": "P", "name": "自研虚拟桌面"}, {"id": "L", "name": "自研虚拟桌面外网白名单"}]

        def list_org_members(self, org_id, **kw):
            if org_id == "P":
                # 父组列表里，子组 L 的行带该组的完整生效策略
                return {
                    "users": [],
                    "subgroups": [
                        {"id": "L", "name": "自研虚拟桌面外网白名单",
                         "strategy": "自研虚拟桌面外网白名单,公司基础白名单"},
                    ],
                }
            # 叶子组 L 的用户：完全继承所属组 → 占位符
            return {"users": [{"name": "ip:172.29.125.0", "strategy": "与所属组相同", "status": True}], "subgroups": []}

    fake = _FakeWeb()
    monkeypatch.setattr(policy_usage_service.session_pool, "get_web_client", lambda inst: fake)
    policy_usage_service.policy_usage_cache.invalidate(778)

    class _Inst:
        id = 778

    out = policy_usage_service.analyze_policy_usage(_Inst())
    by_name = {p["name"]: p for p in out["policies"]}
    # 占位符展开为组策略 → 这两条被判「有人引用」
    assert by_name["自研虚拟桌面外网白名单"]["used"] is True and by_name["自研虚拟桌面外网白名单"]["user_count"] == 1
    assert by_name["公司基础白名单"]["used"] is True
    # 组策略里没有的才是真无人引用
    assert by_name["真没人用"]["used"] is False
    assert out["unused_count"] == 1 and out["total_users"] == 1

