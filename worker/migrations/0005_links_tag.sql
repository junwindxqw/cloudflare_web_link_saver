-- links 增加属性标签列：规则识别的主题分类，可手动修改，侧栏按标签筛选
ALTER TABLE links ADD COLUMN tag TEXT NOT NULL DEFAULT '';
