# Video Model Reference

This is the objective request contract verified from the live model schemas on
2026-08-02. The server remains the source of truth and returns validation errors
for unsupported fields.

All models use:

```text
POST /customer/v1/models/{owner}/{model}/predictions
Authorization: Bearer <Ergouzi API key>
Content-Type: application/json

{"input": { ...model fields... }}
```

The Skill accepts documented media fields as HTTPS URLs, supported base64 data
URIs, or local `$local_file` objects. It validates local file signatures before
converting them to data URIs. The final JSON request must remain within 4 MiB;
use HTTPS URLs for larger media. All four models return one MP4 URI.

## `ergouzi/e-video`

Required: `prompt`.

- `image`: optional image URI for image-to-video.
- `last_frame_image`: optional image URI for the last frame.
- `audio`: optional FLAC, MP3, or WAV URI; when present, it controls duration.
- `duration`: `1..20` seconds, default `5`; ignored when audio is present.
- `aspect_ratio`: default `16:9`; ignored when an input image is present.
- `resolution`: `720p` or `1080p`; default `720p`.
- `fps`: `24` or `48`; default `24`.
- `draft`: default `false`.
- `prompt_upsampling`: default `true`.
- `disable_safety_filter`: the live upstream default is `true`; do not change
  this field unless the user explicitly supplies it and applicable policy allows it.
- `save_audio`: default `true`.
- `seed`: optional integer.
- `no_op`: internal health-check field; do not use for normal tasks.

## `ergouzi/e-video-animate`

Required: `video` and `image`.

- `video`: source MP4 URI providing motion and audio.
- `image`: reference subject image URI.
- `instruction_prompt`: optional animation instruction; default empty.
- `resolution`: `720p` or `1080p`; default `720p`.
- `target_fps`: `original`, `24`, or `48`; default `original`.
- `save_audio`: default `true`.
- `ignore_audio`: default `false`; generation ignores source audio, but
  `save_audio=true` can still mux it into the final video.
- `turbo`: default `false`.
- `disable_safety_checker`: default `false`.
- `seed`: optional integer.
- `no_op`: internal health-check field; do not use for normal tasks.

## `ergouzi/e-video-avatar`

Required by schema: `image`. For a usable task, also provide `audio` or a
non-empty `voice_script`; uploaded audio takes precedence.

- `image`: JPG, JPEG, PNG, or WebP URI used as the first frame.
- `audio`: optional FLAC, MP3, or WAV speech audio URI.
- `resolution`: `720p` or `1080p`; default `720p`.
- `voice_script`: exact text to speak when no audio is provided.
- `voice`: one of the live voice enum values; default `Zephyr (Female)`.
- `voice_prompt`: speaking-style instruction; default `Say the following.`.
- `voice_language`: `English (US)`, `English (UK)`, `Spanish`, `French`,
  `German`, `Italian`, `Portuguese (Brazil)`, `Japanese`, `Korean`, or `Hindi`.
- `video_prompt`: visual behavior instruction; default `The person is talking.`.
- `negative_prompt`: optional visual exclusions.
- `strength_negative_prompt`: `0..4`; default `0.5`.
- `seed`: optional integer.
- `disable_prompt_upsampling`: default `false`.
- `disable_safety_filter`: the live upstream default is `true`; do not change
  this field unless the user explicitly supplies it and applicable policy allows it.
- `no_op`: internal health-check field; do not use for normal tasks.

## `ergouzi/e-video-replace`

Required: `video` and `images`.

- `video`: source MP4 URI.
- `images`: 1 to 3 identity-reference image URIs.
- `instruction_prompt`: optional placement instruction; default empty.
- `resolution`: `720p` or `1080p`; default `720p`.
- `target_fps`: `original`, `24`, or `48`; default `original`.
- `save_audio`: default `true`.
- `ignore_audio`: default `false`.
- `turbo`: default `false`.
- `disable_safety_checker`: default `false`.
- `seed`: optional integer.
- `no_op`: internal health-check field; do not use for normal tasks.
