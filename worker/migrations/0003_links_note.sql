-- links 增加备注列：用户自行标识用，可空
ALTER TABLE links ADD COLUMN note TEXT NOT NULL DEFAULT '';
