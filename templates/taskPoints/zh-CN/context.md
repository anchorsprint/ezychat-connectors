请在每行冒号后填写内容，并删除不适用的行。AI 会把空白行视为未知，并把聊天转交给您的团队。

进行中的项目：
员工如何写任务编号（示例）：
佣金支付前由谁检查工作：
佣金何时支付：
积分或佣金问题联系谁：
回复的默认语言：

表格设置（供业主使用；表格设置好后可删除这一部分）
建立一个 Google Sheet，包含以下工作表。每个工作表的第 1 行是列名。在 EzyChat 的 Google Sheets 设置中，按下面所示为此代理设置每个工作表的权限，然后点击 Refresh。

1. Tasks（Read）。由您填写：Project | Task ID | Task | Points | KPI
   每项任务一行。Points 是数字。项目目标（例如 50,000 积分）是该项目所有任务积分的总和。任务编号请勿包含空格，例如 ALPHA017。

2. Completions（Add rows）。AI 为每项报告的任务添加一行：Date | Name | WhatsApp | Group | AI agent | Source | Project | Task ID | Note
   此工作表中不要放公式或其他内容：新行会添加在最后一行下面，公式会把新行推到更下方。AI 从不修改行；您可以自行更正或删除行。

3. Done（Read）。第 1 行：Project | Task ID | Task | Points | Done by | WhatsApp | Date
   在 A2 粘贴以下公式。它只列出 Tasks 中存在的每个项目和任务编号的第一次报告，因此重复报告永远不会增加积分：
   =ARRAYFORMULA(LET(p,Completions!G2:G,t,Completions!H2:H,k,UPPER(REGEXREPLACE(p&"|"&t,"[\s_-]","")),tk,UPPER(REGEXREPLACE(Tasks!A2:A&"|"&Tasks!B2:B,"[\s_-]","")),first,MATCH(k,k,0)=SEQUENCE(ROWS(k)),known,ISNUMBER(MATCH(k,tk,0)),IFERROR(FILTER(HSTACK(IFERROR(VLOOKUP(k,HSTACK(tk,Tasks!A2:D),{2,3,4,5},FALSE),""),Completions!B2:B,Completions!C2:C,Completions!A2:A),(p<>"")*(t<>"")*first*known),"")))

4. Progress（Read；如果不想让员工看到则设为 Off）。第 1 行：Project | Total points | Points done | Progress
   A2: =UNIQUE(FILTER(Tasks!A2:A,Tasks!A2:A<>""))
   B2: =MAP(A2:A,LAMBDA(x,IF(x="","",SUMIF(Tasks!A2:A,x,Tasks!D2:D))))
   C2: =MAP(A2:A,LAMBDA(x,IF(x="","",SUMIF(Done!A2:A,x,Done!D2:D))))
   D2: =MAP(B2:B,C2:C,LAMBDA(total,done,IF(total="","",IF(total=0,0,done/total))))
   把 D 列格式设为百分比（0 至 100 %）。

5. Staff（Off）。由您填写：WhatsApp | Staff name | RM per point
   WhatsApp 号码需包含国家代码，例如 +60123456789。

6. Commission（Off）。第 1 行：WhatsApp | Staff name | RM per point | Points | Commission (RM)
   A2: =FILTER(Staff!A2:C,Staff!A2:A<>"")
   D2: =MAP(A2:A,LAMBDA(w,IF(w="","",IFERROR(SUM(FILTER(Done!D2:D,ARRAYFORMULA(REGEXREPLACE(TO_TEXT(Done!F2:F),"\D",""))=REGEXREPLACE(TO_TEXT(w),"\D",""))),0))))
   E2: =MAP(C2:C,D2:D,LAMBDA(rate,pts,IF(pts="","",rate*pts)))
   如果您的佣金规则不是每积分固定费率，请修改 E2。

积分和佣金只计算 Done 中的行，因此报告两次的任务只付一次。WhatsApp 栏为空的报告，在您填上号码之前不会计入 Commission。
