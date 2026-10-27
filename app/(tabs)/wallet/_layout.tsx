import { Stack } from 'expo-router';
import colors from '@/constants/colors';

export default function WalletLayout() {
  return (
    <Stack
      screenOptions={{
        headerStyle: { backgroundColor: colors.dark.background },
        headerTintColor: colors.dark.text,
        headerTitleStyle: { fontWeight: '700' },
        contentStyle: { backgroundColor: colors.dark.background },
      }}
    >
      <Stack.Screen
        name="index"
        options={{
          title: 'مدیریت دارایی',
          headerTitleAlign: 'center',
        }}
      />
    </Stack>
  );
}
