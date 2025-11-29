<!DOCTYPE html>
<html lang="ko">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>사립탐정 사건 기록부</title>
  <style>
    body {
      margin: 0;
      padding: 0;
      background: #0f0f0f;
      color: #e5e5e5;
      font-family: "Segoe UI", sans-serif;
      display: flex;
      justify-content: center;
      padding: 40px 0;
    }

    .container {
      width: 750px;
      background: #151515;
      border: 1px solid #2c2c2c;
      border-radius: 12px;
      padding: 30px 40px;
      box-shadow: 0 0 25px rgba(0,0,0,0.5);
    }

    .header {
      border-bottom: 1px solid #333;
      padding-bottom: 10px;
      margin-bottom: 20px;
    }

    h1 {
      margin: 0;
      font-size: 28px;
      letter-spacing: 1px;
      color: #f5f5f5;
    }

    .case-block {
      margin-bottom: 40px;
      padding: 25px;
      background: #1b1b1b;
      border-left: 3px solid #5865f2;
      border-radius: 6px;
    }

    .case-title {
      font-size: 20px;
      margin-bottom: 8px;
      color: #ffffff;
    }

    .meta {
      font-size: 14px;
      color: #999;
      margin-bottom: 15px;
    }

    .section {
      margin-top: 18px;
    }

    .section-title {
      font-weight: bold;
      font-size: 15px;
      margin-bottom: 6px;
      color: #d6d6d6;
    }

    .section-content {
      white-space: pre-line;
      line-height: 1.6;
    }

    .footer {
      margin-top: 50px;
      text-align: center;
      font-size: 13px;
      color: #555;
    }
  </style>
</head>
<body>
  <div class="container">
    <div class="header">
      <h1>📁 사립탐정 사건 기록부</h1>
    </div>

    <!-- 사건 템플릿 시작 -->
    <div class="case-block">
      <div class="case-title">사건명: <span style="color:#7aa2ff;">[사건 제목 입력]</span></div>
      <div class="meta">사건번호: XXXX-XX-XXXX | 담당 탐정: [탐정명]</div>

      <div class="section">
        <div class="section-title">Ⅰ. 사건 개요</div>
        <div class="section-content">여기에 사건 개요를 입력합니다.</div>
      </div>

      <div class="section">
        <div class="section-title">Ⅱ. 주요 인물 정보</div>
        <div class="section-content">- 인물 A: 정보
- 인물 B: 정보</div>
      </div>

      <div class="section">
        <div class="section-title">Ⅲ. 증거 목록</div>
        <div class="section-content">- 증거 1
- 증거 2
- 증거 3</div>
      </div>

      <div class="section">
        <div class="section-title">Ⅳ. 분석 & 추론</div>
        <div class="section-content">분석 내용을 적습니다.</div>
      </div>

      <div class="section">
        <div class="section-title">Ⅴ. 결론 / 조치</div>
        <div class="section-content">결론 또는 향후 조치를 입력합니다.</div>
      </div>
    </div>
    <!-- 사건 템플릿 끝 -->

    <div class="footer">© Private Investigation Bureau — Case Log System</div>
  </div>
</body>
</html>
