-- Parsed public page metadata; never raw HTML or search-provider excerpts.
ALTER TABLE page_cache ADD COLUMN facts jsonb;
ALTER TABLE page_cache ADD COLUMN links jsonb NOT NULL DEFAULT '[]';
ALTER TABLE page_cache ADD CONSTRAINT page_links_bounded CHECK(jsonb_array_length(links)<=3);
