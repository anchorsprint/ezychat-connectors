Fill in each line after the colon and delete lines that do not apply. The AI treats an empty line as unknown and hands the chat to your team.

Projects in progress:
How staff write a task ID (example):
Who checks the work before commission is paid:
When commission is paid:
Who to contact about points or commission:
Default language for replies:

SHEET SETUP (for the owner; you can delete this part once the sheet is ready)
Create one Google Sheet with these tabs. Row 1 of each tab holds the column names. In Google Sheets settings in EzyChat, set each tab's access for this agent as shown, then click Refresh.

1. Tasks (Read). You fill it in: Project | Task ID | Task | Points | KPI
   One row per task. Points is a number. A project's target (for example 50,000 points) is the sum of its task points. Use task IDs without spaces, for example ALPHA017.

2. Completions (Add rows). The AI adds one row per reported task: Date | Name | WhatsApp | Group | AI agent | Source | Project | Task ID | Note
   Put no formulas and nothing else in this tab: new rows are added below the last row, and formulas would push them down. Rows are never changed by the AI; you may correct or delete a row yourself.

3. Done (Read). Row 1: Project | Task ID | Task | Points | Done by | WhatsApp | Date
   In A2 paste this formula. It lists only the FIRST report of each project and task ID that exists in Tasks, so a repeated report never adds points:
   =ARRAYFORMULA(LET(p,Completions!G2:G,t,Completions!H2:H,k,UPPER(REGEXREPLACE(p&"|"&t,"[\s_-]","")),tk,UPPER(REGEXREPLACE(Tasks!A2:A&"|"&Tasks!B2:B,"[\s_-]","")),first,MATCH(k,k,0)=SEQUENCE(ROWS(k)),known,ISNUMBER(MATCH(k,tk,0)),IFERROR(FILTER(HSTACK(IFERROR(VLOOKUP(k,HSTACK(tk,Tasks!A2:D),{2,3,4,5},FALSE),""),Completions!B2:B,Completions!C2:C,Completions!A2:A),(p<>"")*(t<>"")*first*known),"")))

4. Progress (Read, or Off if staff should not see it). Row 1: Project | Total points | Points done | Progress
   A2: =UNIQUE(FILTER(Tasks!A2:A,Tasks!A2:A<>""))
   B2: =MAP(A2:A,LAMBDA(x,IF(x="","",SUMIF(Tasks!A2:A,x,Tasks!D2:D))))
   C2: =MAP(A2:A,LAMBDA(x,IF(x="","",SUMIF(Done!A2:A,x,Done!D2:D))))
   D2: =MAP(B2:B,C2:C,LAMBDA(total,done,IF(total="","",IF(total=0,0,done/total))))
   Format column D as percent (0 to 100 %).

5. Staff (Off). You fill it in: WhatsApp | Staff name | RM per point
   WhatsApp with country code, for example +60123456789.

6. Commission (Off). Row 1: WhatsApp | Staff name | RM per point | Points | Commission (RM)
   A2: =FILTER(Staff!A2:C,Staff!A2:A<>"")
   D2: =MAP(A2:A,LAMBDA(w,IF(w="","",IFERROR(SUM(FILTER(Done!D2:D,ARRAYFORMULA(REGEXREPLACE(TO_TEXT(Done!F2:F),"\D",""))=REGEXREPLACE(TO_TEXT(w),"\D",""))),0))))
   E2: =MAP(C2:C,D2:D,LAMBDA(rate,pts,IF(pts="","",rate*pts)))
   Change E2 if your commission rule is not a fixed rate per point.

Points and commission count only rows in Done, so a task reported twice is paid once. A report whose WhatsApp cell is empty is not counted in Commission until you fill in the number.
