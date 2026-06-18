#! /usr/bin/env python3
# coding=utf-8
"""新建访问权限策略的默认骨架与报文构造。

骨架取自真实「新建(add)」抓包的最小策略对象（application 之外的 keyword / filetype /
saas / mail / ssl / qqctrl / proxy / samerole / 时间 / 标志位等全为设备默认值）。新建时
``opr=add``，``data`` 结构与「编辑(modify)」一致——仅 application 段的规则、name/depict/
enable 由用户决定，其余沿用骨架默认值。

注意：**适用用户/对象（use_info）不在此 add 报文中**，由设备另一条 acnetpolicy 请求保存；
新建出的策略在设置适用人员前不对任何人生效。
"""

from __future__ import annotations

import copy
import json
import random
import time

# 来自真实新建抓包的默认骨架（已将 application.data 置空、name 置空，供构造时填充）。
_TEMPLATE_JSON = r"""
{"appctrl":{"application":{"data":[],"include":true},"network":{"data":[],"include":false},"proxy":{"http":{"enable":false},"sock":{"enable":false},"errorproto":{"enable":false},"disable_acc":{"sn_disable":true},"proxycheck":{"lockout":{}},"include":false}},"keyword":{"email":{"enable":false,"address":""},"search":{"data":[]},"http":{"data":[]},"include":false},"filetype":{"upload":{"data":[],"whiteList":"","exclude":false},"download":{"data":[],"whiteList":"","exclude":false},"include":false,"ftp":false},"saas":{"google":{"forcesafe":false,"onlyenterprise":false,"url":""},"youtube":{"default_url":[{"url":"UC-9-kyTW8ZkZNDHQJ6FgpwQ","desc":"音乐","enable":false},{"url":"UCF0pVplsI8R5kcAqgtoRqoA","desc":"热门","enable":false},{"url":"UCEgdi0XIXXZ-qJOFPf4JSKw","desc":"体育","enable":false},{"url":"gaming","desc":"游戏","enable":false},{"url":"UClgRkhTL3_hImCAmdLfDE4g","desc":"电影","enable":false},{"url":"UCl8dMTqDrJQ0c8y23UBu4kQ","desc":"电视节目","enable":false},{"url":"UCYfdidRxbB8Qhf0Nx7ioOYw","desc":"新闻","enable":false},{"url":"UC4R8DWoMoI7CAwX8_LjQHig","desc":"直播","enable":false},{"url":"UCBR8-60-B28hp2BmDPdntcQ","desc":"焦点","enable":false}],"forcesafe":false,"onlychannel":false,"custom":false,"channel":""},"office":{"onlyenterprise":false,"url":""},"bing":{"forcesafe":false},"facebook":{"onlyforwork":false,"onlyurl":false,"url":""},"dropbox":{"onlyenterprise":false},"include":false},"ssl":{},"mail":{"include":false,"sendrecv":{"src":{"deny":{"enable":true,"suffix":""},"allow":{"suffix":""}},"dst":{"deny":{"enable":true,"suffix":""},"allow":{"suffix":""}},"keyword":{"enable":false,"contents":""},"attachment":{"enable":false,"types":""},"advance":{"advance":{"mailsize":{"enable":false,"size":0},"attachno":{"enable":false,"number":0},"junk":false,"sn_disable":true}}},"audit":{"tip":{"delay":{"enable":false,"address":""},"mailsize":{"enable":false,"size":"0"},"attachno":{"enable":false,"number":"0"},"cc":{"enable":false,"number":"0"},"keyword":{"enable":false,"contents":""}},"nodelay":{"enable":false,"address":""},"email":{"enable":false,"address":""},"sn_disable":false,"enable":false}},"qqctrl":{"include":false,"qqlist":""},"type":1,"enable":true,"samerole":{"permit":["permit1","permit0"],"permit1":true,"permit0":true},"lowrole":true,"expire":"never","never":true,"date":{"date":"","enable":false},"name":"","depict":"","highpri":false}
"""

_DEFAULT = json.loads(_TEMPLATE_JSON)


def _gen_rule_id(index: int) -> str:
    """生成与设备一致风格的规则 ID（毫秒时间戳 + 随机/序号，保证策略内唯一）。"""
    return f"{int(time.time() * 1000)}{random.randint(100, 999)}{index:02d}"


def _ref_to_device(ref: dict) -> dict | None:
    path = str(ref.get("path") or "").strip()
    if not path:
        return None
    out = {"path": path, "type": ref.get("type", ""), "crc": "" if ref.get("crc") is None else str(ref.get("crc"))}
    if ref.get("extra"):
        out["extra"] = ref["extra"]
    return out


def build_policy_create_data(form: dict) -> dict:
    """据表单字段（name/depict/enable/include/rules）构造新建策略的完整 ``data``。

    rules 形如 ``[{"action": bool, "refs": [{path,type,crc,extra}...]}...]``；规则 ID 由本函数
    生成。其余配置段沿用骨架默认值。
    """
    data = copy.deepcopy(_DEFAULT)
    data["name"] = str(form.get("name", "") or "")
    data["depict"] = str(form.get("depict", "") or "")
    data["enable"] = bool(form.get("enable", True))

    rules_out: list[dict] = []
    for i, rule in enumerate(form.get("rules", []) or []):
        refs = [d for d in (_ref_to_device(r) for r in (rule.get("refs") or []) if isinstance(r, dict)) if d]
        rules_out.append(
            {
                "action": bool(rule.get("action", False)),
                "apps": {"tags": [], "apps": refs, "extra": []},
                "name": _gen_rule_id(i),
                "time": "全天",
            }
        )

    application = data["appctrl"]["application"]
    application["data"] = rules_out
    # 「应用控制」勾选与否，对应 application.include
    application["include"] = bool(form.get("include", True))
    return data
