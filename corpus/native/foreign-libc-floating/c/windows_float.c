#ifdef _WIN32
// Windows' system CRT exports fabs, but not a scalar fabsf entry. The C conversion
// keeps the float argument/return ABI independently compiled on this target.
extern double fabs(double);
float silk_test_fabsf(float value) { return (float)fabs((double)value); }
#endif
