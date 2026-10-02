-- 20260830112511  add_missing_formation_principle_names
-- Exported from Supabase project epkuvykamufrrgbacbel on 2026-10-02.
-- This is the applied migration history, pulled back from the server.

-- The 6 principles with no recording yet: name + statement + schedule only.
-- transcript stays null and content.transcriptStatus = 'missing' so the UI can
-- render the full 13-step journey while showing which weeks lack audio.

insert into public.resources (type, title, content, tags, active, sort_order, transcript, source_ref)
values
(
  'formation_principle',
  'God Is Telling a Story in Your Life',
  jsonb_build_object(
    'principleNumber', 1,
    'principleStatement', 'God is telling a story in your life. Spoiler alert: Stories that God tells end well. God tells redemptive stories.',
    'series', '13 Formation Principles',
    'seriesAltName', 'The Journey to Discovery',
    'scheduledDate', 'May 31, 2026',
    'scriptures', jsonb_build_array('Romans 8:28', 'Philippians 1:6'),
    'templates', jsonb_build_array('Abraham', 'David', 'Peter'),
    'themes', jsonb_build_array('redemptive story','providence','life narrative','biblical templates'),
    'transcriptStatus', 'missing',
    'sourceOutline', 'Discovery Summer Series Outline'
  ),
  array['formation','identity','principle-1']::text[], true, 1, null, null
),
(
  'formation_principle',
  'God Is Big, But God Is Relational',
  jsonb_build_object(
    'principleNumber', 4,
    'principleStatement', 'God is big, but God is relational (He is immanent), so He makes Himself discoverable. He is too big to be fully discovered. He will give you bite-sized revelations that only reveal a part of Him. Each revelation is transformative.',
    'series', '13 Formation Principles',
    'seriesAltName', 'The Journey to Discovery',
    'scheduledDate', 'June 21, 2026',
    'scriptures', jsonb_build_array('Exodus 33:18'),
    'themes', jsonb_build_array('transcendence','immanence','progressive revelation','conversation with God'),
    'transcriptStatus', 'missing',
    'sourceOutline', 'Discovery Summer Series Outline'
  ),
  array['formation','identity','principle-4']::text[], true, 4, null, null
),
(
  'formation_principle',
  'Instructions Come Before Identity',
  jsonb_build_object(
    'principleNumber', 8,
    'principleStatement', 'Instructions come before identity.',
    'series', '13 Formation Principles',
    'seriesAltName', 'The Journey to Discovery',
    'scheduledDate', 'July 19, 2026',
    'scriptures', jsonb_build_array('Matthew 7:7'),
    'themes', jsonb_build_array('obedience','faith precedes understanding','leaving the comfort zone'),
    'transcriptStatus', 'missing',
    'sourceOutline', 'Discovery Summer Series Outline'
  ),
  array['formation','identity','principle-8']::text[], true, 8, null, null
),
(
  'formation_principle',
  'Discovery Requires Dismantling',
  jsonb_build_object(
    'principleNumber', 10,
    'principleStatement', 'Discovery requires dismantling. True identity comes just as much through removal as it does through revelation.',
    'series', '13 Formation Principles',
    'seriesAltName', 'The Journey to Discovery',
    'scheduledDate', 'August 2, 2026',
    'themes', jsonb_build_array('dismantling lies','wilderness','nothing is wasted','removal as formation'),
    'transcriptStatus', 'missing',
    'sourceOutline', 'Discovery Summer Series Outline'
  ),
  array['formation','identity','principle-10']::text[], true, 10, null, null
),
(
  'formation_principle',
  'Identity Opens and Closes Doors',
  jsonb_build_object(
    'principleNumber', 11,
    'principleStatement', 'Identity revelations open doors to fruitful responsibilities and close doors to fruitless expeditions.',
    'series', '13 Formation Principles',
    'seriesAltName', 'The Journey to Discovery',
    'scheduledDate', 'August 9, 2026',
    'themes', jsonb_build_array('discernment','fruitfulness','calling and limits','knowing what to do'),
    'transcriptStatus', 'missing',
    'sourceOutline', 'Discovery Summer Series Outline'
  ),
  array['formation','identity','principle-11']::text[], true, 11, null, null
),
(
  'formation_principle',
  'You''ll Never Arrive, But You Will Find What You Seek',
  jsonb_build_object(
    'principleNumber', 13,
    'principleStatement', 'You''ll never arrive but you will find what you seek.',
    'series', '13 Formation Principles',
    'seriesAltName', 'The Journey to Discovery',
    'scheduledDate', 'August 23, 2026',
    'scriptures', jsonb_build_array('1 Corinthians 13:9-12'),
    'themes', jsonb_build_array('mystery','knowing in part','ongoing journey','seeking'),
    'transcriptStatus', 'missing',
    'sourceOutline', 'Discovery Summer Series Outline'
  ),
  array['formation','identity','principle-13']::text[], true, 13, null, null
);

-- Mark the 7 that DO have audio, and stamp the outline's schedule + canonical wording on them
update public.resources set content = content
  || jsonb_build_object('transcriptStatus','present','seriesAltName','The Journey to Discovery')
  || case (content->>'principleNumber')::int
       when 2  then jsonb_build_object('scheduledDate','June 7, 2026',   'canonicalStatement','Lasting peace comes when we discover the story, and begin to partner with it. This is the essence of the journey. By partnership, we mean alignment and participation.')
       when 3  then jsonb_build_object('scheduledDate','June 14, 2026',  'canonicalStatement','God will reveal Himself to you first. (In many cases, He already has.)')
       when 5  then jsonb_build_object('scheduledDate','June 28, 2026',  'canonicalStatement','God has His own language and communication style. He uses metaphor and He loves questions.')
       when 6  then jsonb_build_object('scheduledDate','July 5, 2026',   'canonicalStatement','As you "discover God," you will experience revelations about yourself. You are made in the image of God and have a unique identity and purpose.')
       when 7  then jsonb_build_object('scheduledDate','July 12, 2026',  'canonicalStatement','God loves names. He uses names to define and advance us. Discovery often comes with a name.')
       when 9  then jsonb_build_object('scheduledDate','July 26, 2026',  'canonicalStatement','The journey requires faith. God initiates and is also responsive. Follow the wind.')
       when 12 then jsonb_build_object('scheduledDate','August 16, 2026','canonicalStatement','Discovery flourishes in covenant community.')
       else '{}'::jsonb
     end
where type = 'formation_principle' and transcript is not null;
