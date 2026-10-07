# XSS 探针（浏览器内零弹窗）

本文件验证原始 HTML 是否被转义为字面文本。

<script>alert('PROBE_SCRIPT_1')</script>

<img src=x onerror="alert('PROBE_ONERROR_2')">

<style>body{display:none}</style>

<svg onload="alert('PROBE_SVG_3')"></svg>

[x](javascript:alert('PROBE_JS_4'))

[y](data:text/html;base64,PHNjcmlwdD5hbGVydCgnUFJPQkVfREFUQV81Jyk8L3NjcmlwdD4=)

<!-- <script>alert('PROBE_COMMENT_6')</script> -->

## 围栏内逃逸探针

```
</code></pre><script>alert('PROBE_FENCE_7')</script>
```

以上内容全部应显示为转义文本，页面不得弹出任何 alert，body 不得被隐藏。
