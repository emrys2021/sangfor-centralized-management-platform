#! /usr/bin/env python3
# coding=utf-8
"""核心逻辑离线单元测试（不依赖真实 AC 设备）。"""

from __future__ import annotations

import pytest

from app.core.security import decrypt, encrypt
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
    assert decrypt("not-a-valid-token") == ""


def _client() -> SangforWebClient:
    c = SangforWebClient("https", "127.0.0.1", 443, "u", "p")
    c._logged_in = True  # 跳过真实登录
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

    含 ``rules``（get_policy_detail 解析结果，供 build_remapped_rules 使用）与 ``raw``
    （完整对象，供 add 路径 remap_policy_data 使用）。
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
                                    {"path": "访问网站/钉钉白名单/网站浏览", "type": "power", "crc": "S-9002", "extra": "url"},
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


def test_remap_policy_data_replaces_crc_and_strips_envelope():
    """crc 用目标值覆盖、信封与适用对象剔除、其余字段保留。"""
    from app.services.policy_sync import build_app_index, remap_policy_data

    index = build_app_index(_sample_app_tree())
    data, missing = remap_policy_data(_source_policy_detail(), index)

    assert missing == []
    assert "success" not in data and "use_info" not in data  # 信封 / 适用对象剔除
    refs = data["appctrl"]["application"]["data"][0]["apps"]["apps"]
    assert refs[0]["crc"] == "T-2002"  # 自定义应用 → 目标 crc
    assert refs[1]["crc"] == "T-3003"  # 访问网站 → 目标 crc
    assert refs[0]["path"] == "自定义/钉钉应用"  # 路径等非 crc 字段原样保留
    assert data["appctrl"]["application"]["include"] is True


def test_remap_policy_data_reports_missing_reference():
    """目标缺被引用对象时记入 missing，且不臆造 crc。"""
    from app.services.policy_sync import remap_policy_data

    # 目标 app 树缺「自定义/钉钉应用」，仅有访问网站
    index = {"访问网站/钉钉白名单/网站浏览": {"crc": "T-3003", "type": "power"}}
    data, missing = remap_policy_data(_source_policy_detail(), index)

    assert missing == ["自定义/钉钉应用"]
    refs = data["appctrl"]["application"]["data"][0]["apps"]["apps"]
    assert refs[0]["crc"] == "S-9001"  # 缺失项保持原值（不臆造），由调用方阻止落盘


def test_remap_policy_data_does_not_mutate_source():
    """重建为深拷贝，不污染源详情对象（同源可重复用于多个目标）。"""
    from app.services.policy_sync import build_app_index, remap_policy_data

    src = _source_policy_detail()
    index = build_app_index(_sample_app_tree())
    remap_policy_data(src, index)
    # 源对象的 crc 未被改动
    src_refs = src["raw"]["appctrl"]["application"]["data"][0]["apps"]["apps"]
    assert src_refs[0]["crc"] == "S-9001"


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
    """缺失引用区分可创建（源自定义）与硬缺失（内置/源也无）。"""
    from app.services.policy_sync import classify_missing

    creatable, hard = classify_missing(
        ["自定义/钉钉应用", "访问网站/钉钉白名单/网站浏览", "Web流媒体/全部"],
        source_custom_apps={"钉钉应用"},
        source_custom_urls={"钉钉白名单"},
    )
    paths = {c["path"]: c for c in creatable}
    assert paths["自定义/钉钉应用"]["kind"] == "app" and paths["自定义/钉钉应用"]["name"] == "钉钉应用"
    assert paths["访问网站/钉钉白名单/网站浏览"]["kind"] == "url"
    assert hard == ["Web流媒体/全部"]  # 内置应用无法自动创建


class _FakeTargetWeb:
    """记录写调用的目标设备替身。"""

    def __init__(self, tree, *, has_policy):
        self._tree = tree
        self._has_policy = has_policy
        self.modify_calls: list = []
        self.create_policy_calls: list = []

    def list_app_tree(self):
        return self._tree

    def modify_policy_application(self, name, rules, **kw):
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
    """目标无此策略 → 走 create_policy（opr=add），data crc 已重映射。"""
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
                            {"name": "网站浏览", "type": "power", "value": "访问网站/钉钉白名单/网站浏览", "crc": "T-3003", "extra": "url"},
                        ],
                    }
                ],
            }
        ]
    }
    target = _FakeTargetWeb(partial_tree, has_policy=True)
    out = sync_policy_to_target(
        source_web=None, target_web=target, source_detail=_source_policy_detail(),
        exists=True, dry_run=True,
        source_custom_apps={"钉钉应用"}, source_custom_urls={"钉钉白名单"},
    )
    assert out["created"] == ["自定义/钉钉应用"]  # 源自定义应用 → 预告将创建
    assert out["missing"] == []  # 钉钉应用可创建、访问网站已存在，无硬缺失


def test_sync_policy_real_write_blocks_on_builtin_missing():
    """real-write：遇无法自动创建的内置缺失 → 抛错整体阻止，不写策略。"""
    from app.services.policy_sync import sync_policy_to_target

    # 目标缺内置「Web流媒体/全部」，源详情引用它
    detail = _source_policy_detail()
    detail["rules"][0]["refs"].append({"path": "Web流媒体/全部", "type": "app", "crc": "S-1", "extra": ""})
    partial_tree = {
        "data": [
            {"name": "自定义", "type": "catagory", "children": [
                {"name": "钉钉应用", "type": "app", "value": "自定义/钉钉应用", "crc": "T-2002"}]},
            {"name": "访问网站", "type": "catagory", "children": [
                {"name": "钉钉白名单", "type": "catagory", "children": [
                    {"name": "网站浏览", "type": "power", "value": "访问网站/钉钉白名单/网站浏览", "crc": "T-3003", "extra": "url"}]}]},
        ]
    }
    target = _FakeTargetWeb(partial_tree, has_policy=True)
    with pytest.raises(SangforWebError):
        sync_policy_to_target(
            source_web=None, target_web=target, source_detail=detail,
            exists=True, dry_run=False, source_custom_apps=set(), source_custom_urls=set(),
        )
    assert not target.modify_calls  # 未写策略
