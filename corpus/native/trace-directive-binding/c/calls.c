static int state;
void trace_value(int value) { state += value; }
int trace_result(void) { return state == 43 ? 0 : 1; }
