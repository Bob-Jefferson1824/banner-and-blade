-- The four permanent houses. Blue and Green names are deliberately NULL: they are undecided and must be
-- configured later (UPDATE houses SET display_name=..., name_status='final'). Nothing may invent them.
CREATE TABLE houses (
  id           text PRIMARY KEY CHECK (id IN ('blue', 'red', 'green', 'gold')),
  display_name text,
  name_status  text NOT NULL DEFAULT 'temporary' CHECK (name_status IN ('temporary', 'final')),
  color        text NOT NULL,
  sort_order   smallint NOT NULL UNIQUE,
  CHECK (name_status = 'temporary' OR display_name IS NOT NULL)
);
INSERT INTO houses (id, display_name, name_status, color, sort_order) VALUES
  ('blue',  NULL,                 'temporary', '#4b88f2', 1),
  ('red',   'House Ravenscourt',  'final',     '#e3493b', 2),
  ('green', NULL,                 'temporary', '#4caf50', 3),
  ('gold',  'House Goldcrest',    'final',     '#e2b956', 4);
