#! /usr/bin/env python3
# coding=utf-8
"""自定义 URL 库编辑请求模型。"""

from __future__ import annotations

from pydantic import BaseModel


class UrlGroupForm(BaseModel):
    """新增 / 编辑自定义 URL 库的表单字段（对应设备 ``data`` 的 name/depict/url/keyword）。"""

    name: str
    depict: str = ""
    # 换行分隔的 URL / IP 文本（与设备 data.url 一致）
    url: str = ""
    # 关键字（换行分隔，对应设备 data.keyword）
    keyword: str = ""
