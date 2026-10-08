-- 纯文本 / 图片增加备注列：与链接备注一致，侧栏可按备注筛选全部类型
ALTER TABLE snippets ADD COLUMN note TEXT NOT NULL DEFAULT '';
