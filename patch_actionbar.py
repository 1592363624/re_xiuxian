#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
临时补丁脚本：向 ActionBar.vue 的 refinedActions 数组追加 second_soul 与 small_world 按钮。
执行后即可删除。
"""
import io
import sys

file_path = r'd:\WorkSpace\IntelliJIDEAWorkspace\re_xiuxian\client\src\components\panels\ActionBar.vue'

with io.open(file_path, 'r', encoding='utf-8') as f:
    content = f.read()

# 原始锚点（ascension 项末尾 + 下一个 world_boss 项开头）
old_block = """  {
    id: 'ascension',
    name: '\u98de\u5347',
    // Amber/gold for ascension - matches \u98de\u5347\u7075\u754c gold theme
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-amber-300"><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 16.8l-6.2 4.5 2.4-7.4L2 9.4h7.6z"/></svg>`,
    desc: '\u98de\u5347\u7075\u754c \u593a\u820d\u91cd\u751f'
  },
  {
    id: 'world_boss',"""

new_block = """  {
    id: 'ascension',
    name: '\u98de\u5347',
    // Amber/gold for ascension - matches \u98de\u5347\u7075\u754c gold theme
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-amber-300"><path d="M12 2l2.4 7.4H22l-6.2 4.5 2.4 7.4L12 16.8l-6.2 4.5 2.4-7.4L2 9.4h7.6z"/></svg>`,
    desc: '\u98de\u5347\u7075\u754c \u593a\u820d\u91cd\u751f'
  },
  {
    id: 'second_soul',
    name: '\u5143\u795e',
    // Purple for second soul / doppelganger - matches \u7b2c\u4e8c\u5143\u795e purple theme
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-purple-300"><circle cx="12" cy="8" r="3"/><path d="M12 11v9"/><path d="M8 14l4-2 4 2"/><path d="M9 20h6"/></svg>`,
    desc: '\u7b2c\u4e8c\u5143\u795e \u51dd\u7ec3\u5206\u5316'
  },
  {
    id: 'small_world',
    name: '\u754c',
    // Cyan/jade for small world - matches \u5c0f\u4e16\u754c cyan/jade theme
    icon: `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" class="text-cyan-300"><circle cx="12" cy="12" r="10"/><path d="M2 12h20"/><path d="M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z"/></svg>`,
    desc: '\u5c0f\u4e16\u754c \u795e\u5e99\u6cd5\u5219'
  },
  {
    id: 'world_boss',"""

if old_block not in content:
    print('ERROR: old_block not found in ActionBar.vue')
    sys.exit(1)

if 'second_soul' in content and 'small_world' in content:
    print('SKIP: second_soul / small_world already exist in ActionBar.vue')
    sys.exit(0)

new_content = content.replace(old_block, new_block, 1)
with io.open(file_path, 'w', encoding='utf-8