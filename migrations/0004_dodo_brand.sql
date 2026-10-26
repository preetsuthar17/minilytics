-- One Dodo business can have several brands, and Dodo sends every brand's payments to every webhook.
-- When set, a site only records payments from this Dodo brand (brand_id on the payment).
ALTER TABLE sites ADD COLUMN dodo_brand_id TEXT;
