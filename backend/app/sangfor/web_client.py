#! /usr/bin/env python3
# coding=utf-8
"""深信服 AC Web/CGI 客户端（按 CGI 拆分后在此组合）。

通道（端口 443）：自定义应用 ``customrule.cgi`` / 自定义 URL 库 ``objurlgrp.cgi`` /
访问权限策略 ``netpolicy.cgi`` / 策略应用对象与应用树 ``acnetpolicy.cgi``。

传输与鉴权见 :class:`~app.sangfor.web_base.SangforWebBase`；各 CGI 能力分别在
``customrule_cgi`` / ``url_cgi`` / ``policy_cgi`` 中以 mixin 实现。写操作在报文
未抓包确认前一律走 dry-run（见 ``web_base._write_cgi`` 与 ``CONFIRMED_WRITES``）。
"""
from __future__ import annotations

from app.sangfor.customrule_cgi import CustomRuleCgiMixin
from app.sangfor.policy_cgi import PolicyCgiMixin
from app.sangfor.url_cgi import UrlCgiMixin
from app.sangfor.web_base import CONFIRMED_WRITES, SangforWebBase, SangforWebError

__all__ = ["CONFIRMED_WRITES", "SangforWebClient", "SangforWebError"]


class SangforWebClient(CustomRuleCgiMixin, UrlCgiMixin, PolicyCgiMixin, SangforWebBase):
    """单个 AC 实例的 Web/CGI 会话客户端。

    组合：传输/鉴权基类 :class:`SangforWebBase` + 三类 CGI 能力 mixin
    （自定义应用 / URL 库 / 访问权限策略）。
    """
