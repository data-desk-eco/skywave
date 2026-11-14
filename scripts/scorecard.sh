#!/bin/sh
# capture_burst output → arrival times → residuals at ais truth →
# receiver clock offsets (fitted on half the vessels) → fixes on the
# other half → error summary. safe to re-run while a capture grows.
#
#   [SLAVES="captures/x.jsonl"] scripts/scorecard.sh captures/nov2 [extra toa_fix flags, e.g. --fuse 20]
set -e
c=$1; shift
touch ${c}_toa.jsonl
node scripts/burst_toa.mjs $c.jsonl $SLAVES ${c}_toa.jsonl >> ${c}_toa.jsonl
node scripts/toa_score.mjs ${c}_toa.jsonl ${c}_ais.jsonl > ${c}_res.jsonl
for h in a b; do
  o=$([ $h = a ] && echo b || echo a)
  node scripts/toa_bias.mjs ${c}_res.jsonl --kind ais --half $h --json ${c}_bias_$h.json > /dev/null
  node scripts/toa_fix.mjs ${c}_toa.jsonl --ais ${c}_ais.jsonl --bias ${c}_bias_$h.json --half $o --minq 5 "$@" > ${c}_fix_$o.jsonl
done
node scripts/toa_bias.mjs ${c}_res.jsonl --kind ais --json ${c}_bias.json
duckdb -c "
create table f as select * from read_json_auto('${c}_fix_?.jsonl') where kind = 'ais';
select count(*) fixes, round(median(q)) receivers, round(median(errKm), 1) p50_km, round(quantile_cont(errKm, .75), 1) p75_km,
  round(quantile_cont(errKm, .9), 1) p90_km, round(median(smaj), 1) ellipse_km from f;
select case when smaj < 5 then 'a <5' when smaj < 15 then 'b <15' when smaj < 40 then 'c <40' else 'd >=40' end ellipse_km,
  count(*) fixes, round(median(q)) receivers, round(median(errKm), 1) p50_km, round(quantile_cont(errKm, .9), 1) p90_km,
  round(median(errKm / smaj), 2) err_over_ellipse from f group by all order by 1;"
