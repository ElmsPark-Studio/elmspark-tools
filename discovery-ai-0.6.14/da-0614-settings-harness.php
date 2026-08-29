<?php
/*
	Discovery AI 0.6.14 settings-boundary harness.
	Boots the live PageMotor install on the CLI (init only, no routing) and
	exercises the exact methods the MCP/AJAX layers dispatch to:
	_api_get_settings / _api_save_settings / _settings.

	PRINTS NO SECRET VALUES — only PASS/FAIL lines, sha256 digests of field
	values, sentinel checks, and mask last-4s.

	Usage: php da-0614-settings-harness.php <webroot> <host>
*/

error_reporting(E_ERROR | E_PARSE);

$webroot = $argv[1] ?? '';
$host = $argv[2] ?? '';
if ($webroot === '' || $host === '') {
	fwrite(STDERR, "usage: harness <webroot> <host>\n");
	exit(2);
}

$_SERVER['HTTP_HOST'] = $host;
$_SERVER['HTTPS'] = 'on';
$_SERVER['SERVER_PORT'] = '443';
$_SERVER['REQUEST_URI'] = '/pm-0614-harness-probe/';
$_SERVER['REQUEST_METHOD'] = 'GET';
$_SERVER['REMOTE_ADDR'] = '127.0.0.1';
$_SERVER['SCRIPT_NAME'] = '/index.php';

require_once($webroot . '/pagemotor.php');
// PM 0.11.2 moved define('PM_ROOT', __DIR__) out of the PageMotor constructor and into
// index.php. A CLI bootstrap skips index.php, so without this the constructor dies with
// "Undefined constant PM_ROOT". Older cores still define it themselves, and defining it
// first would make THEIR define() warn (a fatal in PHP 9), so only step in when the core
// no longer does it.
if (!defined('PM_ROOT') && strpos(file_get_contents($webroot . '/pagemotor.php'), "define('PM_ROOT'") === false)
	define('PM_ROOT', $webroot);
if (!function_exists('apply_filters')) {
	function apply_filters($filter, $value) { return $value; }
}

global $motor;
$motor = new PageMotor;
$motor->init();
// Replicate the top of PageMotor::run() WITHOUT routing: theme _init() invokes
// every plugin's _init(), populating the settings SCHEMA. Framework save
// methods validate against that schema — invoking them pre-_init validates
// against [] and full-replaces the options row with nothing.
$motor->theme->_init();
if (!empty($motor->admin))
	$motor->admin->_init();

$fails = 0;
function check($label, $ok) {
	global $fails;
	echo ($ok ? 'PASS' : 'FAIL') . " — $label\n";
	if (!$ok) $fails++;
}
function h($v) { return hash('sha256', (string) $v); }

$SENTINEL = '__EP_SECRET_SET__';
$SECRETS = array(
	'api_key', 'openai_api_key', 'assistant_api_key',
	'twilio_account_sid', 'twilio_auth_token', 'whoapi_key',
	'stripe_test_secret_key', 'stripe_live_secret_key', 'stripe_webhook_secret',
	'partner_shared_secret', 'telemetry_secret');
$READABLES = array('stripe_mode', 'exempt_emails', 'free_generation_cap',
	'setup_mode', 'stripe_price_cents', 'stripe_currency', 'legal_jurisdiction',
	'notification_email', 'model', 'image_gen_backend', 'twilio_from_number');

// Locate the live Discovery_AI instance
$dai = null;
foreach (array('theme', 'admin') as $ctx) {
	if (empty($motor->$ctx) || empty($motor->$ctx->_plugins->active)) continue;
	foreach ($motor->$ctx->_plugins->active as $p)
		if (!empty($p->_class) && $p->_class === 'Discovery_AI') { $dai = $p; break 2; }
}
check('Discovery_AI instance located', $dai !== null);
if (!$dai) exit(1);

// HARD SAFETY GATE: never run a save test against an empty settings schema —
// core validation would full-replace the options row with []. (Learned the
// hard way on 2026-07-13; the staging row had to be reconstructed from prod.)
$schema_ok = is_array($dai->_settings) && count($dai->_settings) > 3;
check('settings schema populated (save-safety gate)', $schema_ok);
if (!$schema_ok) {
	echo "REFUSING to run any save test against an empty schema.\n";
	exit(1);
}

$row_pre_json = json_encode($motor->options->option('Discovery_AI'));
$stored = json_decode($row_pre_json, true);
echo "row sha256 pre: " . h($row_pre_json) . "\n";

$pre_hash = array();
foreach ($SECRETS as $f)
	$pre_hash[$f] = isset($stored[$f]) && is_string($stored[$f]) ? h($stored[$f]) : 'ABSENT';

// ── [1] Masked echo ──────────────────────────────────────────────
$echo1 = $dai->_api_get_settings();
$es = !empty($echo1['data']['settings']) && is_array($echo1['data']['settings'])
	? $echo1['data']['settings'] : array();
check('_api_get_settings returns settings map', !empty($es));

foreach ($SECRETS as $f) {
	$real = isset($stored[$f]) && is_string($stored[$f]) ? $stored[$f] : '';
	$out = isset($es[$f]) ? $es[$f] : null;
	if ($real === '') {
		check("echo[$f] empty stays empty/absent", $out === '' || $out === null || $out === false);
	} else {
		$masked = is_string($out) && strpos($out, $SENTINEL) === 0;
		$last4ok = is_string($out) && (strlen($real) < 8 || substr($out, -4) === substr($real, -4));
		$noleak = is_string($out) ? (strpos($out, $real) === false) : true;
		check("echo[$f] sentinel-masked, last4 " . (is_string($out) ? substr($out, -4) : '—'),
			$masked && $last4ok && $noleak);
	}
}
foreach ($READABLES as $f) {
	$real = isset($stored[$f]) ? $stored[$f] : null;
	$out = isset($es[$f]) ? $es[$f] : null;
	check("echo[$f] readable + unmodified", $out == $real);
}
echo "readable stripe_mode: " . json_encode($es['stripe_mode'] ?? null) . "\n";
echo "readable free_generation_cap: " . json_encode($es['free_generation_cap'] ?? null) . "\n";
echo "readable setup_mode: " . json_encode($es['setup_mode'] ?? null) . "\n";
echo "readable exempt_emails: " . json_encode($es['exempt_emails'] ?? null) . "\n";

// ── [2] Round-trip clobber test: write the masked echo straight back ──
$save1 = $dai->_api_save_settings(array('settings' => $es));
check('round-trip _api_save_settings succeeds', !empty($save1['success']));

$row_rt_json = json_encode($motor->options->option('Discovery_AI'));
$after_rt = json_decode($row_rt_json, true);
foreach ($SECRETS as $f) {
	$now = isset($after_rt[$f]) && is_string($after_rt[$f]) ? h($after_rt[$f]) : 'ABSENT';
	// A stored-empty secret may round-trip to an absent key (both read back as
	// empty); only a real value changing is a clobber.
	$ok = ($now === $pre_hash[$f]) || ($pre_hash[$f] === h('') && ($now === 'ABSENT' || $now === h('')));
	check("post-roundtrip [$f] value hash unchanged", $ok);
}
foreach ($READABLES as $f)
	check("post-roundtrip [$f] unchanged", ($after_rt[$f] ?? null) == ($stored[$f] ?? null));
echo "row sha256 post-roundtrip: " . h($row_rt_json) . ($row_rt_json === $row_pre_json ? " (byte-identical)" : " (NORMALISED — differs)") . "\n";

// ── [3] Absent-secret-keys save preserves stored secrets ─────────
$partial = $es;
foreach ($SECRETS as $f) unset($partial[$f]);
$save2 = $dai->_api_save_settings(array('settings' => $partial));
check('absent-keys _api_save_settings succeeds', !empty($save2['success']));
$after_abs = $motor->options->option('Discovery_AI');
foreach ($SECRETS as $f) {
	$now = isset($after_abs[$f]) && is_string($after_abs[$f]) ? h($after_abs[$f]) : 'ABSENT';
	$ok = ($now === $pre_hash[$f]) || ($pre_hash[$f] === h('') && ($now === 'ABSENT' || $now === h('')));
	check("post-absent-save [$f] preserved", $ok);
}

// ── [4] New-value / explicit-clear / restore semantics (whoapi_key) ──
// Skipped in prod mode: the semantics are code-identical and already proven
// on staging; no reason to hold a probe value in a live setting even briefly.
if (($argv[3] ?? '') !== 'prod') {
	$orig_whoapi = isset($after_abs['whoapi_key']) && is_string($after_abs['whoapi_key']) ? $after_abs['whoapi_key'] : '';
	$probe_val = 'probe-new-value-0614-' . substr(h(uniqid('', true)), 0, 8);

	$m = $dai->_api_get_settings(); $map = $m['data']['settings'];
	$map['whoapi_key'] = $probe_val;
	$dai->_api_save_settings(array('settings' => $map));
	$r = $motor->options->option('Discovery_AI');
	check('new value overwrites', isset($r['whoapi_key']) && $r['whoapi_key'] === $probe_val);

	$m = $dai->_api_get_settings(); $map = $m['data']['settings'];
	$map['whoapi_key'] = '';
	$dai->_api_save_settings(array('settings' => $map));
	$r = $motor->options->option('Discovery_AI');
	check('explicit empty clears', empty($r['whoapi_key']));

	$m = $dai->_api_get_settings(); $map = $m['data']['settings'];
	$map['whoapi_key'] = $orig_whoapi;
	$dai->_api_save_settings(array('settings' => $map));
	$r = $motor->options->option('Discovery_AI');
	$now = isset($r['whoapi_key']) && is_string($r['whoapi_key']) ? h($r['whoapi_key']) : h('');
	check('whoapi_key restored to original', $now === ($orig_whoapi === '' ? h('') : h($orig_whoapi)));
}
else {
	echo "prod mode: new-value/clear/restore section skipped (staging-proven)\n";
}

// ── [5] Admin settings form HTML leak check ──────────────────────
$form = $dai->_settings(1);
$html = isset($form['form']) ? $form['form'] : '';
check('_settings() renders form HTML', strlen($html) > 1000);
$leaked = array();
foreach ($SECRETS as $f) {
	$real = isset($stored[$f]) && is_string($stored[$f]) ? $stored[$f] : '';
	if ($real !== '' && strpos($html, $real) !== false)
		$leaked[] = $f;
}
check('no real secret value appears in form HTML', empty($leaked));
if (!empty($leaked)) echo "LEAKED FIELDS: " . implode(', ', $leaked) . "\n";
$pw_count = substr_count($html, 'type="password"');
check("form has 11 password inputs (found $pw_count)", $pw_count === 11);
$ac_count = substr_count($html, 'autocomplete="new-password"');
check("form has 11 new-password autocompletes (found $ac_count)", $ac_count === 11);
$sent_count = substr_count($html, $SENTINEL);
echo "sentinel occurrences in form HTML: $sent_count\n";

// ── [6] ai-options echo sanity ───────────────────────────────────
$ai = $dai->_api_get_ai_options();
$ai_map = isset($ai['data']['ai_options']) ? (array) $ai['data']['ai_options'] : array();
$ai_leak = false;
foreach ($SECRETS as $f) {
	$real = isset($stored[$f]) && is_string($stored[$f]) ? $stored[$f] : '';
	if ($real === '') continue;
	foreach ($ai_map as $v)
		if (is_string($v) && strpos($v, $real) !== false) $ai_leak = true;
}
check('_api_get_ai_options carries no plugin secrets', !$ai_leak);

// ── [7] Final integrity: row equals pre state ────────────────────
$row_final_json = json_encode($motor->options->option('Discovery_AI'));
echo "row sha256 final: " . h($row_final_json) . ($row_final_json === $row_pre_json ? " (byte-identical to pre)" : " (DIFFERS from pre)") . "\n";
$final = json_decode($row_final_json, true);
foreach ($SECRETS as $f) {
	$now = isset($final[$f]) && is_string($final[$f]) ? h($final[$f]) : 'ABSENT';
	$ok = ($now === $pre_hash[$f]) || ($pre_hash[$f] === h('') && ($now === 'ABSENT' || $now === h('')));
	check("final [$f] hash equals pre-harness", $ok);
}

echo $fails === 0 ? "\nALL CHECKS PASSED\n" : "\n$fails CHECK(S) FAILED\n";
exit($fails === 0 ? 0 : 1);
